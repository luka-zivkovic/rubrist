import { ProductionCalibrationTimestampSchema } from '@rubrist/shared';

export class InvalidProductionTimestampError extends Error {
 constructor() {super('Invalid production timestamp');this.name='InvalidProductionTimestampError';}
}

// PostgreSQL timestamptz stores microseconds. Normalize accepted ISO timestamps
// without passing their fractional part through JavaScript's millisecond Date.
// Fixed-width UTC text then has the same chronological and SQL window ordering.
// Accept exactly the shared contract: seconds and fractions are optional, and
// an offset is Z or ±HH:MM.
export function productionTimestamp(value:string):string {
 const match=ProductionCalibrationTimestampSchema.safeParse(value).success?/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value):null;
 if(!match)throw new InvalidProductionTimestampError();
 const second=Date.parse(`${match[1]}:${match[2]??'00'}${match[4]}`);if(!Number.isFinite(second))throw new InvalidProductionTimestampError();
 const fraction=match[3]??'',head=fraction.slice(0,6).padEnd(6,'0'),tail=fraction.slice(6);
 let micros=Number(head);
 // Round to nearest microsecond, choosing the even one at an exact half.
 if(tail&&((tail[0]!>'5')||(tail[0]==='5'&&(/[1-9]/.test(tail.slice(1))||micros%2===1))))micros++;
 const normalized=new Date(second+(micros===1_000_000?1000:0)).toISOString().slice(0,19);
 return `${normalized}.${String(micros%1_000_000).padStart(6,'0')}Z`;
}
