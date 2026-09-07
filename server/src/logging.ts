import {
  createRuntimeLogger,
  type LogSink,
  type RuntimeLogger,
} from '@mikaelcedergren/cx-framework/server/logging';

let active: RuntimeLogger | undefined;

/** Product identity only; the published framework owns privacy, context and bounded transport. */
export function configureHandmarkLogging(
  environment: NodeJS.ProcessEnv = process.env,
  releaseId = 'source',
  sink?: LogSink,
): RuntimeLogger {
  const mode = environment['NODE_ENV'];
  const nodeEnvironment = mode === 'production' || mode === 'test' ? mode : 'development';
  active = createRuntimeLogger({
    ...(sink ? { sink } : {}),
    identity: {
      service: 'handmark',
      role: 'web',
      releaseId,
      pid: process.pid,
      environment: nodeEnvironment,
      executionScope: environment['CX_EXECUTION_SCOPE'] ?? nodeEnvironment,
    },
  });
  return active;
}

export const handmarkLog: Pick<RuntimeLogger, 'emit'> = Object.freeze({
  emit(event) {
    return (active ?? configureHandmarkLogging()).emit(event);
  },
});
