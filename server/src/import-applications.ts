import { pathToFileURL } from 'node:url';

import { importApplicationsJsonl } from './application-import.js';

interface ImportArguments {
  readonly databasePath: string;
  readonly sourcePath: string;
}

export function parseImportArguments(arguments_: readonly string[]): ImportArguments {
  let databasePath: string | undefined;
  let sourcePath: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--source' || argument === '--database') {
      const value = arguments_[index + 1];
      if (!value) throw new Error(`${argument} requires a path.`);
      if (argument === '--source') {
        if (sourcePath !== undefined) throw new Error('--source may be supplied only once.');
        sourcePath = value;
      } else {
        if (databasePath !== undefined) throw new Error('--database may be supplied only once.');
        databasePath = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`Unknown application import option: ${String(argument)}`);
  }
  if (!sourcePath || !databasePath) {
    throw new Error('Application import requires --source and --database.');
  }
  return Object.freeze({ databasePath, sourcePath });
}

export async function runApplicationImport(arguments_: readonly string[]): Promise<void> {
  const receipt = await importApplicationsJsonl(parseImportArguments(arguments_));
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void runApplicationImport(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Application import failed safely.');
    process.exitCode = 1;
  });
}
