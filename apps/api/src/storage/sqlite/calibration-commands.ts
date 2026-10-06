import type {DatabaseSync} from 'node:sqlite';
import {BinaryCalibrationRepositoryError,type BinaryCalibrationControlRepository} from '../../binary-calibration/repository.js';
import {createCalibrationRun} from './calibration-run-commands.js';
import {sqliteCalibrationClaimCommands} from './calibration-claim-commands.js';
import {sqliteCalibrationExecutionCommands} from './calibration-execution-commands.js';
import {sqliteCalibrationMintCommands} from './calibration-mint-commands.js';
import {sqliteResolutionCommands} from './resolution-commands.js';
type Args<K extends keyof BinaryCalibrationControlRepository>=Parameters<BinaryCalibrationControlRepository[K]>;
export function sqliteCalibrationCommands(db:DatabaseSync){
 const claims=sqliteCalibrationClaimCommands(db),execution=sqliteCalibrationExecutionCommands(db),mint=sqliteCalibrationMintCommands(db),resolution=sqliteResolutionCommands(db);
 const commands={
  calibrationCreate:(...args:Args<'createRun'>)=>createCalibrationRun(db,...args),
  calibrationList:claims.listRuns,calibrationGet:claims.getRun,
  calibrationGetArtifact:mint.getArtifact,calibrationGetArtifactStatus:mint.getArtifactStatus,
  calibrationGetGovernedBinding:resolution.getGovernedBinding,
  calibrationRecordResolution:(...args:Args<'recordResolution'>)=>resolution.recordResolution(...args),
  calibrationListRunnable:claims.listRunnableRunIds,calibrationClaim:claims.claimRun,
  calibrationHeartbeat:claims.heartbeatClaim,calibrationRecheckTarget:claims.getRecheckTarget,
  calibrationRecordRecheck:claims.recordRecheck,calibrationReject:claims.rejectBeforeAuthorization,
  calibrationAuthorize:execution.authorizeRun,calibrationRecover:execution.recoverStartedAttempts,
  calibrationNextAttempt:execution.getNextAttempt,calibrationProviderStarted:execution.recordProviderCallStarted,
  calibrationCompleteAttempt:execution.completeAttempt,calibrationFinalize:mint.finalizeRun,
  calibrationMarkRecovery:claims.markRecoveryRequired
 };
 for(const name of Object.keys(commands) as Array<keyof typeof commands>){const command=commands[name] as (...args:any[])=>unknown;Object.assign(commands,{[name]:(...args:any[])=>{try{return command(...args);}catch(error){
  if(error instanceof BinaryCalibrationRepositoryError)throw error;
  const e=error as {errcode?:number;message?:string};
  if(((e.errcode??0)&255)===19)throw new BinaryCalibrationRepositoryError(e.message?.includes('UNIQUE')||/immutable|state|monotonic|claim|lease|attempt/.test(e.message??'')?'state_conflict':'ineligible','Binary calibration command conflicts with retained evidence');
  throw error;
 }}});}
 return commands;
}
