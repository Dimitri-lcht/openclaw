import path from "node:path";
import { isShellWrapperInvocation } from "./shell-wrapper-resolution.js";

const CMD_OPERATOR_CHARS = /[&|<>^()\r\n]/;

function isArgumentSeparator(ch: string | undefined): boolean {
  return ch === " " || ch === "\t";
}

function hasForbiddenControlChar(command: string): boolean {
  for (let index = 0; index < command.length; index += 1) {
    const code = command.charCodeAt(index);
    const lineBreakOrTab = code === 0x09 || code === 0x0a || code === 0x0d;
    if ((code < 0x20 && !lineBreakOrTab) || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function readProgramName(command: string): { program: string; next: number } | null {
  if (command.startsWith('"')) {
    const closing = command.indexOf('"', 1);
    const program = closing === -1 ? "" : command.slice(1, closing);
    const glued = closing + 1 < command.length && !isArgumentSeparator(command[closing + 1]);
    if (!program || /[\r\n]/.test(program) || glued) {
      return null;
    }
    return { program, next: closing + 1 };
  }
  let end = 0;
  while (end < command.length && !isArgumentSeparator(command[end])) {
    end += 1;
  }
  const program = command.slice(0, end);
  if (!program || program.includes('"') || CMD_OPERATOR_CHARS.test(program)) {
    return null;
  }
  return { program, next: end };
}

function splitArguments(
  command: string,
  start: number,
  doubledQuoteInQuotes: "stays-quoted" | "ends-quote",
): string[] | null {
  const argv: string[] = [];
  let index = start;
  while (index < command.length) {
    while (isArgumentSeparator(command[index])) {
      index += 1;
    }
    if (index >= command.length) {
      break;
    }
    let arg = "";
    let quoted = false;
    while (index < command.length) {
      const ch = command[index] ?? "";
      if (ch === "\\") {
        let run = 0;
        while (command[index + run] === "\\") {
          run += 1;
        }
        if (command[index + run] !== '"') {
          arg += "\\".repeat(run);
          index += run;
          continue;
        }
        arg += "\\".repeat(Math.floor(run / 2));
        index += run;
        if (run % 2 === 1) {
          arg += '"';
          index += 1;
        }
        continue;
      }
      if (ch === '"') {
        if (quoted && command[index + 1] === '"') {
          arg += '"';
          index += 2;
          quoted = doubledQuoteInQuotes === "stays-quoted";
          continue;
        }
        quoted = !quoted;
        index += 1;
        continue;
      }
      if (!quoted && isArgumentSeparator(ch)) {
        break;
      }
      if (!quoted && CMD_OPERATOR_CHARS.test(ch)) {
        return null;
      }
      arg += ch;
      index += 1;
    }
    if (quoted && doubledQuoteInQuotes === "stays-quoted") {
      return null;
    }
    argv.push(arg);
  }
  return argv;
}

export function splitWindowsDirectCommandLine(rawCommand: string): string[] | null {
  const command = rawCommand.replace(/^[ \t]+/, "");
  if (hasForbiddenControlChar(command)) {
    return null;
  }
  const head = readProgramName(command);
  if (!head) {
    return null;
  }
  const runtimeArgs = splitArguments(command, head.next, "stays-quoted");
  const shellArgs = splitArguments(command, head.next, "ends-quote");
  if (
    !runtimeArgs ||
    !shellArgs ||
    runtimeArgs.length !== shellArgs.length ||
    runtimeArgs.some((arg, index) => arg !== shellArgs[index])
  ) {
    return null;
  }
  return [head.program, ...runtimeArgs];
}

const NATIVE_EXECUTABLE_SUFFIX = /\.(exe|com)$/;

function countPercentSigns(command: string): number {
  let count = 0;
  for (let index = 0; index < command.length; index += 1) {
    if (command[index] === "%") {
      count += 1;
    }
  }
  return count;
}

// cmd.exe resolves a bare name through PATH and PATHEXT, so `mytool` can land on
// `mytool.cmd`. Classifying only the submitted token would admit an allowlisted batch
// shim as a direct argv, and resolveSafeChildProcessInvocation would then reinsert
// cmd.exe after policy had already authorized a shell-free launch. Requiring an
// absolute native image keeps the launched transport identical to the authorized one.
function isNativeExecutableTarget(executable: string): boolean {
  if (!path.win32.isAbsolute(executable)) {
    return false;
  }
  // Win32 drops trailing dots and spaces when it opens the image, and a stream suffix
  // such as `tool.exe:alt` names a different target, so match the canonical name only.
  const name = path.win32
    .basename(executable)
    .toLowerCase()
    .replace(/[. ]+$/, "");
  return NATIVE_EXECUTABLE_SUFFIX.test(name);
}

// analyzeArgvCommand drops empty and whitespace-only arguments, and the node builds an
// automatically allowlisted launch from that filtered analysis. A direct argv carrying
// a blank argument would therefore run a command the approval never saw, so the direct
// path declines it and the shell transport keeps the argument.
function hasBlankArgument(argv: string[]): boolean {
  return argv.slice(1).some((argument) => argument.trim().length === 0);
}

export function resolveWindowsDirectCommandArgv(command: string): string[] | null {
  const trimmed = command.trim();
  // cmd.exe expands %VAR% even inside double quotes, and an expansion needs a pair of
  // percent signs. Leaving those commands on the shell transport preserves the meaning
  // they had before direct execution existed.
  if (countPercentSigns(trimmed) >= 2) {
    return null;
  }
  const argv = splitWindowsDirectCommandLine(trimmed);
  const executable = argv?.[0];
  if (
    !argv ||
    !executable ||
    !isNativeExecutableTarget(executable) ||
    hasBlankArgument(argv) ||
    isShellWrapperInvocation(argv)
  ) {
    return null;
  }
  return argv;
}
