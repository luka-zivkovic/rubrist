/** PostgreSQL UTC JSON timestamps within its supported four-digit AD year domain. */
export function governedTimestamp(value:string):string {
 const date=/^(\d{4})-(\d{2})-(\d{2})T/.exec(value);
 if(!date)throw new Error('Invalid governed timestamp');
 const year=Number(date[1]),month=Number(date[2]),day=Number(date[3]);
 const leap=year%4===0&&(year%100!==0||year%400===0);
 const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
 if(year===0||month<1||month>12||day<1||day>days[month-1]!)throw new Error('Invalid governed timestamp calendar date');
 const offset=/([+-])(\d{2}):?(\d{2})$/.exec(value);
 if(offset&&(Number(offset[2])>15||Number(offset[3])>59))throw new Error('Invalid governed timestamp offset');
 const parts=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/.exec(value);
 if(!parts)throw new Error('Invalid governed timestamp');
 const second=Date.parse(parts[1]!+parts[3]!);
 if(!Number.isFinite(second))throw new Error('Invalid governed timestamp');
 // PostgreSQL parses fractional seconds through binary64 and then rint(),
 // which differs from decimal-lexeme rounding just either side of a tie.
 const scaled=Number('0.'+(parts[2]??'0'))*1_000_000,lower=Math.floor(scaled),remainder=scaled-lower;
 const micros=lower+(remainder>0.5||(remainder===0.5&&lower%2===1)?1:0);
 const instant=new Date(second+(micros===1_000_000?1000:0)).toISOString();
 if(!/^\d{4}-/.test(instant))throw new Error('Governed timestamp exceeds supported years 0001–9999');
 const normalized=instant.slice(0,19)+'.'+String(micros%1_000_000).padStart(6,'0')+'Z';
 // Rounding or an offset may cross the supported AD year boundary. Fail closed
 // rather than slicing the extended ISO year into a different digest value.
 if(!/^[0-9]{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(normalized)||normalized.startsWith('0000'))throw new Error('Governed timestamp exceeds supported years 0001–9999');
 const fraction=normalized.slice(20,26).replace(/0+$/,'');
 return normalized.slice(0,19)+(fraction?'.'+fraction:'')+'+00:00';
}
