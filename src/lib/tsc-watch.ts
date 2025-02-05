#!/usr/bin/env node

import nodeCleanup, { uninstall } from 'node-cleanup';
import spawn from 'cross-spawn';
import { run } from './runner';
import { extractArgs } from './args-manager';
import { manipulate, detectState, deleteClear, print } from './stdout-manipulator';
import { createInterface } from 'readline';
import { ChildProcess } from 'child_process';

let firstTime = true;
let firstSuccessKiller: (() => Promise<void>) | null = null;
let successKiller: (() => Promise<void>) | null = null;
let failureKiller: (() => Promise<void>) | null = null;
let compilationStartedKiller: (() => Promise<void>) | null = null;
let compilationCompleteKiller: (() => Promise<void>) | null = null;

const {
  onFirstSuccessCommand,
  onSuccessCommand,
  onFailureCommand,
  onCompilationStarted,
  onCompilationComplete,
  maxNodeMem,
  noColors,
  noClear,
  requestedToListEmittedFiles,
  signalEmittedFiles,
  silent,
  compiler,
  args,
} = extractArgs(process.argv);

let runningKillProcessesPromise: Promise<number> | null = null;
function killProcesses(currentCompilationId: number, killAll: boolean): Promise<number> {
  if (runningKillProcessesPromise) {
    return runningKillProcessesPromise.then(() => currentCompilationId);
  }

  const promisesToWaitFor: Promise<any>[] = [];
  if (killAll && firstSuccessKiller) {
    promisesToWaitFor.push(firstSuccessKiller());
    firstSuccessKiller = null;
  }

  if (successKiller) {
    promisesToWaitFor.push(successKiller());
    successKiller = null;
  }

  if (failureKiller) {
    promisesToWaitFor.push(failureKiller());
    failureKiller = null;
  }

  if (compilationStartedKiller)   {
    promisesToWaitFor.push(compilationStartedKiller());
    compilationStartedKiller = null;
  }

  if (compilationCompleteKiller) {
    promisesToWaitFor.push(compilationCompleteKiller());
    compilationCompleteKiller = null;
  }

  runningKillProcessesPromise = Promise.all(promisesToWaitFor).then(() => {
    runningKillProcessesPromise = null;
    return currentCompilationId;
  });

  return runningKillProcessesPromise;
}

function runOnCompilationStarted(): void {
  if (onCompilationStarted) {
    compilationStartedKiller = run(onCompilationStarted);
  }
}

function runOnCompilationComplete(): void {
  if (onCompilationComplete) {
    compilationCompleteKiller = run(onCompilationComplete);
  }
}

function runOnFailureCommand(): void {
  if (onFailureCommand) {
    failureKiller = run(onFailureCommand);
  }
}

function runOnFirstSuccessCommand(): void {
  if (onFirstSuccessCommand) {
    firstSuccessKiller = run(onFirstSuccessCommand);
  }
}

function runOnSuccessCommand(): void {
  if (onSuccessCommand) {
    successKiller = run(onSuccessCommand);
  }
}

function getTscPath(): string {
  let tscBin: string;
  try {
    return require.resolve(compiler);
  } catch (e: any) {
    if (e.code === 'MODULE_NOT_FOUND') {
      console.error(e.message);
      process.exit(9);
    }
    throw e;
  }
}

interface INodeSettings {
  maxNodeMem: string | null;
  requestedToListEmittedFiles: boolean;
  signalEmittedFiles: boolean;
}

function spawnTsc({ maxNodeMem, requestedToListEmittedFiles, signalEmittedFiles }: INodeSettings, args: string[]): ChildProcess {
  const tscBin = getTscPath();
  const nodeArgs = [
    ...((maxNodeMem) ? [`--max_old_space_size=${maxNodeMem}`] : []),
    tscBin,
    ...((signalEmittedFiles || requestedToListEmittedFiles) ? ['--listEmittedFiles'] : []),
    ...args
  ];

  return spawn('node', nodeArgs);
}

function echoExit(code: number | null, signal: string | null) {
  if (signal !== null) {
    process.kill(process.pid, signal);
  }
}

let compilationErrorSinceStart = false;
const tscProcess = spawnTsc({ maxNodeMem, requestedToListEmittedFiles, signalEmittedFiles }, args);
if (!tscProcess.stdout) {
  throw new Error('Unable to read Typescript stdout');
}
if (!tscProcess.stderr) {
  throw new Error('Unable to read Typescript stderr');
}

tscProcess.on('exit', echoExit);
tscProcess.stderr.pipe(process.stderr);

const rl = createInterface({ input: tscProcess.stdout });

let compilationId = 0;
rl.on('line', function (input) {
  if (noClear) {
    input = deleteClear(input);
  }

  const line = manipulate(input);
  if (!silent) {
    print(line, { noColors, noClear, signalEmittedFiles, requestedToListEmittedFiles });
  }
  const state = detectState(line);
  const compilationStarted = state.compilationStarted;
  const compilationError = state.compilationError;
  const compilationComplete = state.compilationComplete;

  compilationErrorSinceStart =
    (!compilationStarted && compilationErrorSinceStart) || compilationError;

  if (state.fileEmitted !== null) {
    Signal.emitFile(state.fileEmitted);
  }

  if (compilationStarted) {
    compilationId++;
    killProcesses(compilationId, false).then((previousCompilationId) => {
      if (previousCompilationId !== compilationId) {
        return;
      }
      runOnCompilationStarted();
      Signal.emitStarted();
    });
  }
  
  if (compilationComplete) {
    compilationId++;
    killProcesses(compilationId, false).then((previousCompilationId) => {
      if (previousCompilationId !== compilationId) {
        return;
      }
      runOnCompilationComplete();

      if (compilationErrorSinceStart) {
        Signal.emitFail();
        runOnFailureCommand();
      } else {
        if (firstTime) {
          firstTime = false;
          Signal.emitFirstSuccess();
          runOnFirstSuccessCommand();
        }

        Signal.emitSuccess();
        runOnSuccessCommand();
      }
    });
  }
});

if (typeof process.on === 'function') {
  process.on('message', (msg: string) => {
    switch (msg) {
      case 'run-on-compilation-started-command':
        if (compilationStartedKiller) {
          compilationStartedKiller().then(runOnCompilationStarted);
        }
        break;

      case 'run-on-compilation-complete-command':
        if (compilationCompleteKiller) {
          compilationCompleteKiller().then(runOnCompilationComplete);
        }
        break;

      case 'run-on-first-success-command':
        if (firstSuccessKiller) {
          firstSuccessKiller().then(runOnFirstSuccessCommand);
        }
        break;

      case 'run-on-failure-command':
        if (failureKiller) {
          failureKiller().then(runOnFailureCommand);
        }
        break;

      case 'run-on-success-command':
        if (successKiller) {
          successKiller().then(runOnSuccessCommand);
        }
        break;

      default:
        console.log('Unknown message', msg);
    }
  });
}

const sendSignal = (msg: string) => {
  if (process.send) {
    process.send(msg);
  }
};

const Signal = {
  emitStarted: () => sendSignal('started'),
  emitFirstSuccess: () => sendSignal('first_success'),
  emitSuccess: () => sendSignal('success'),
  emitFail: () => sendSignal('compile_errors'),
  emitFile: (path: string) => sendSignal(`file_emitted:${path}`),
};

nodeCleanup((_exitCode: number | null, signal: string | null) => {
  if (signal) {
    tscProcess.kill(signal);
  }
  killProcesses(0, true).then(() => process.exit());
  // don't call cleanup handler again
  uninstall();
  return false;
});
