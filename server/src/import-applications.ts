import { pathToFileURL } from 'node:url';

import { importApplicationsJsonl, importEmptyApplicationsAuthority } from './application-import.js';

interface ImportArguments {
  readonly authorityKind: 'legacy_jsonl_v1' | 'legacy_empty_absence_v1';
  readonly databasePath: string;
  readonly operationalRoot: string;
  readonly sourcePath: string;
}

export function parseImportArguments(arguments_: readonly string[]): ImportArguments {
  let databasePath: string | undefined;
  let emptyAuthority = false;
  let operationalRoot: string | undefined;
  let sourcePath: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--empty-authority') {
      if (emptyAuthority) throw new Error('--empty-authority may be supplied only once.');
      emptyAuthority = true;
      continue;
    }
    if (argument === '--source' || argument === '--database' || argument === '--operational-root') {
      const value = arguments_[index + 1];
      if (!value) throw new Error(`${argument} requires a path.`);
      if (argument === '--source') {
        if (sourcePath !== undefined) throw new Error('--source may be supplied only once.');
        sourcePath = value;
      } else if (argument === '--database') {
        if (databasePath !== undefined) throw new Error('--database may be supplied only once.');
        databasePath = value;
      } else {
        if (operationalRoot !== undefined) {
          throw new Error('--operational-root may be supplied only once.');
        }
        operationalRoot = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`Unknown application import option: ${String(argument)}`);
  }
  if (!sourcePath || !databasePath || !operationalRoot) {
    throw new Error('Application import requires --operational-root, --source, and --database.');
  }
  return Object.freeze({
    authorityKind: emptyAuthority ? 'legacy_empty_absence_v1' : 'legacy_jsonl_v1',
    databasePath,
    operationalRoot,
    sourcePath,
  });
}

export async function runApplicationImport(arguments_: readonly string[]): Promise<void> {
  const { authorityKind, ...options } = parseImportArguments(arguments_);
  const receipt = await (authorityKind === 'legacy_empty_absence_v1'
    ? importEmptyApplicationsAuthority(options)
    : importApplicationsJsonl(options));
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void runApplicationImport(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Application import failed safely.');
    process.exitCode = 1;
  });
}
