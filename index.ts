import {EventEmitter} from 'events';
import { ChildProcess,spawn, SpawnOptions, exec } from 'child_process';
import {EOL as newline, tmpdir} from 'os';
import {join, sep} from 'path'
import {Readable,Writable} from 'stream'
import { writeFile, writeFileSync } from 'fs';

function toArray<T>(source?:T|T[]):T[] {
    if (typeof source === 'undefined' || source === null) {
        return [];
    } else if (!Array.isArray(source)) {
        return [source];
    }
    return source;
}

/**
 * adds arguments as properties to obj
 */
function extend(obj:{}, ...args) {
    Array.prototype.slice.call(arguments, 1).forEach(function (source) {
        if (source) {
            for (let key in source) {
                obj[key] = source[key];
            }
        }
    });
    return obj;
}

export interface Options extends SpawnOptions{
    mode?: 'text'|'json'|'binary'
    formatter?: (param:string)=>any
    parser?: (param:string)=>any
    stderrParser?: (param:string)=>any
    encoding?: string
    pythonPath?: string
    /**
     * see https://docs.python.org/3.7/using/cmdline.html
     */
    pythonOptions?: string[]
    /**
     * the scriptPath passed to PythonShell is executed relative to scriptFolder, if specified
     */
    scriptFolder?: string
    /**
     * arguments to your program
     */
    args?: string[]
}

class PythonShellError extends Error{
    traceback: string | Buffer;
    exitCode?:number;
}

/**
 * An interactive Python shell exchanging data through stdio
 * @param {string} script    The python script to execute
 * @param {object} [options] The launch options (also passed to child_process.spawn)
 * @constructor
 */
export class PythonShell extends EventEmitter{
    scriptPath:string
    command:string[]
    mode:string
    formatter:(param:string|Object)=>any
    parser:(param:string)=>any
    stderrParser:(param:string)=>any
    terminated:boolean
    childProcess:ChildProcess
    stdin: Writable;
    stdout: Readable;
    stderr: Readable;
    exitSignal:string;
    exitCode:number;
    private stderrHasEnded:boolean;
    private stdoutHasEnded:boolean;
    private _remaining:string
    private _endCallback:(err:PythonShellError, exitCode:number, exitSignal:string)=>any

    // starting 2020 python2 is deprecated so we choose 3 as default
    // except for windows which just has "python" command
    static defaultPythonPath = process.platform != "win32" ? "python3" : "python";

    static defaultOptions:Options = {}; //allow global overrides for options
    
    constructor(scriptPath:string, options?:Options) {
        super();

        /**
         * returns either pythonshell func (if val string) or custom func (if val Function)
         */
        function resolve(type, val:string|Function) {
            if (typeof val === 'string') {
                // use a built-in function using its name
                return PythonShell[type][val];
            } else if (typeof val === 'function') {
                // use a custom function
                return val;
            }
        }

        let self = this;
        let errorData = '';
        EventEmitter.call(this);

        options = <Options>extend({}, PythonShell.defaultOptions, options);
        let pythonPath:string;
        if (!options.pythonPath) {
            pythonPath = PythonShell.defaultPythonPath;
        } else pythonPath = options.pythonPath;
        let pythonOptions = toArray(options.pythonOptions);
        let scriptArgs = toArray(options.args);

        this.scriptPath = join(options.scriptFolder || '', scriptPath);
        this.command = pythonOptions.concat(this.scriptPath, scriptArgs);
        this.mode = options.mode || 'text';
        this.formatter = resolve('format', options.formatter || this.mode);
        this.parser = resolve('parse', options.parser || this.mode);
        this.stderrParser = resolve('parse', options.stderrParser || this.mode);
        this.terminated = false;
        this.childProcess = spawn(pythonPath, this.command, options);

        ['stdout', 'stdin', 'stderr'].forEach(function (name) {
            self[name] = self.childProcess[name];
            self.parser && self[name].setEncoding(options.encoding || 'utf8');
        });

        // parse incoming data on stdout
        if (this.parser) {
            this.stdout.on('data', this.receive.bind(this));
        }

        // listen to stderr and emit errors for incoming data
        this.stderr.on('data', function (data) {
            errorData += ''+data;
            self.receiveStderr(data);
        });

        this.stderr.on('end', function(){
            self.stderrHasEnded = true
            terminateIfNeeded();
        })

        this.stdout.on('end', function(){
            self.stdoutHasEnded = true
            terminateIfNeeded();
        })

        this.childProcess.on('exit', function (code,signal) {
            self.exitCode = code;
            self.exitSignal = signal;
            terminateIfNeeded();
        });

        function terminateIfNeeded() {
            if(!self.stderrHasEnded || !self.stdoutHasEnded || (self.exitCode == null && self.exitSignal == null)) return;

            let err:PythonShellError;
            if (self.exitCode && self.exitCode !== 0) {
                if (errorData) {
                    err = self.parseError(errorData);
                } else {
                    err = new PythonShellError('process exited with code ' + self.exitCode);
                }
                err = <PythonShellError>extend(err, {
                    executable: pythonPath,
                    options: pythonOptions.length ? pythonOptions : null,
                    script: self.scriptPath,
                    args: scriptArgs.length ? scriptArgs : null,
                    exitCode: self.exitCode
                });
                // do not emit error if only a callback is used
                if (self.listeners('error').length || !self._endCallback) {
                    self.emit('error', err);
                }
            }

            self.terminated = true;
            self.emit('close');
            self._endCallback && self._endCallback(err,self.exitCode,self.exitSignal);
        };
    }

    // built-in formatters
    static format = {
        text: function toText(data):string {
            if (!data) return '';
            else if (typeof data !== 'string') return data.toString();
            return data;
        },
        json: function toJson(data) {
            return JSON.stringify(data);
        }
    };

    //built-in parsers
    static parse = {
        text: function asText(data):string {
            return data;
        },
        json: function asJson(data:string) {
            return JSON.parse(data);
        }
    };

    /**
	 * checks syntax without executing code
	 * @param {string} code
	 * @returns {Promise} rejects w/ stderr if syntax failure
	 */
	static async checkSyntax(code:string){
        let randomInt = PythonShell.getRandomInt();
        let filePath = tmpdir + sep + `pythonShellSyntaxCheck${randomInt}.py`
        
        // todo: replace this with util.promisify (once we no longer support node v7)
	    return new Promise((resolve, reject) => {
            writeFile(filePath, code, (err)=>{
                if (err) reject(err);
                resolve(this.checkSyntaxFile(filePath));
            });
        });
	}

	/**
	 * checks syntax without executing code
	 * @param {string} filePath
	 * @returns {Promise} rejects w/ stderr if syntax failure
	 */
	static async checkSyntaxFile(filePath:string){

	    let compileCommand = `${this.defaultPythonPath} -m py_compile ${filePath}`

        return new Promise((resolve, reject) => {
            exec(compileCommand, (error, stdout, stderr) => {
                if(error == null) resolve()
                else reject(stderr)
            })
        })
	}

    /**
     * Runs a Python script and returns collected messages
     * @param  {string}   scriptPath   The path to the script to execute
     * @param  {Options}   options  The execution options
     * @param  {Function} callback The callback function to invoke with the script results
     * @return {PythonShell}       The PythonShell instance
     */
    static run(scriptPath:string, options?:Options, callback?:(err:PythonShellError, output?:any[])=>any) {
        let pyshell = new PythonShell(scriptPath, options);
        let output = [];

        return pyshell.on('message', function (message) {
            output.push(message);
        }).end(function (err) {
            if (err) return callback(err);
            return callback(null, output.length ? output : null);
        });
    };

    /**
     * Runs the inputted string of python code and returns collected messages. DO NOT ALLOW UNTRUSTED USER INPUT HERE!
     * @param  {string}   code   The python code to execute
     * @param  {Options}   options  The execution options
     * @param  {Function} callback The callback function to invoke with the script results
     * @return {PythonShell}       The PythonShell instance
     */
    static runString(code:string, options?:Options, callback?:(err:PythonShellError, output?:any[])=>any) {

        // put code in temp file
        let randomInt = PythonShell.getRandomInt();
        let filePath = tmpdir + sep + `pythonShellFile${randomInt}.py`
        writeFileSync(filePath, code);

        return PythonShell.run(filePath, options, callback);
    };

    /**
     * Parses an error thrown from the Python process through stderr
     * @param  {string|Buffer} data The stderr contents to parse
     * @return {Error} The parsed error with extended stack trace when traceback is available
     */
    private parseError(data:string|Buffer) {
        let text = ''+data;
        let error:PythonShellError;

        if (/^Traceback/.test(text)) {
            // traceback data is available
            let lines = (''+data).trim().split(new RegExp(newline, 'g'));
            let exception = lines.pop();
            error = new PythonShellError(exception);
            error.traceback = data;
            // extend stack trace
            error.stack += newline+'    ----- Python Traceback -----'+newline+'  ';
            error.stack += lines.slice(1).join(newline+'  ');
        } else {
            // otherwise, create a simpler error with stderr contents
            error = new PythonShellError(text);
        }

        return error;
    };

    /**
     * gets a random int from 0-10000000000
     */
    private static getRandomInt(){
        return Math.floor(Math.random()*10000000000);
    }

    /**
     * Sends a message to the Python shell through stdin
     * Override this method to format data to be sent to the Python process
     * @param {string|Object} data The message to send
     * @returns {PythonShell} The same instance for chaining calls
     */
    send(message:string|Object) {
        let data = this.formatter ? this.formatter(message) : message;
        if (this.mode !== 'binary') data += newline;
        this.stdin.write(data);
        return this;
    };

    /**
     * Parses data received from the Python shell stdout stream and emits "message" events
     * This method is not used in binary mode
     * Override this method to parse incoming data from the Python process into messages
     * @param {string|Buffer} data The data to parse into messages
     */
    receive(data:string|Buffer) {
        return this.recieveInternal(data, 'message');
    };

    /**
     * Parses data received from the Python shell stderr stream and emits "stderr" events
     * This method is not used in binary mode
     * Override this method to parse incoming logs from the Python process into messages
     * @param {string|Buffer} data The data to parse into messages
     */
    receiveStderr(data:string|Buffer) {
        return this.recieveInternal(data, 'stderr');
    };

    private recieveInternal(data:string|Buffer, emitType:'message'|'stderr'){
        let self = this;
        let parts = (''+data).split(new RegExp(newline,'g'));

        if (parts.length === 1) {
            // an incomplete record, keep buffering
            this._remaining = (this._remaining || '') + parts[0];
            return this;
        }

        let lastLine = parts.pop();
        // fix the first line with the remaining from the previous iteration of 'receive'
        parts[0] = (this._remaining || '') + parts[0];
        // keep the remaining for the next iteration of 'receive'
        this._remaining = lastLine;

        parts.forEach(function (part) {
            if(emitType == 'message') self.emit(emitType, self.parser(part));
            else if(emitType == 'stderr') self.emit(emitType, self.stderrParser(part));
        });

        return this;
    }

    /**
     * Closes the stdin stream, which should cause the process to finish its work and close
     * @returns {PythonShell} The same instance for chaining calls
     */
    end(callback:(err:PythonShellError, exitCode:number,exitSignal:string)=>any) {
        this.childProcess.stdin.end();
        this._endCallback = callback;
        return this;
    };

    /**
     * Closes the stdin stream, which should cause the process to finish its work and close
     * @returns {PythonShell} The same instance for chaining calls
     */
    terminate(signal?:string) {
        this.childProcess.kill(signal);
        this.terminated = true;
        return this;
    };
};
