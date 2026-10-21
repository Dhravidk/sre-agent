export function validateMonitor(monitor) {
  if(!monitor||typeof monitor.id!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(monitor.id))throw new Error('Metric monitor needs a unique URL-safe id');
  if(typeof monitor.selector!=='string'||!monitor.selector.trim()||monitor.selector.length>4000)throw new Error('Metric monitor needs a bounded selector');
  if(!Number.isFinite(monitor.threshold)||!['gt','lt'].includes(monitor.operator))throw new Error('Metric monitor needs a finite threshold and gt/lt operator');
  const count=monitor.consecutive??3,maxAge=monitor.maxSampleAgeSeconds??180,maxGap=monitor.maxSampleGapSeconds??180;
  if(!Number.isInteger(count)||count<1||count>10)throw new Error('Metric consecutive count must be an integer between 1 and 10');
  for(const [name,value] of [['maxSampleAgeSeconds',maxAge],['maxSampleGapSeconds',maxGap]])if(!Number.isFinite(value)||value<1||value>900)throw new Error('Metric '+name+' must be between 1 and 900');
  return {count,maxAge,maxGap};
}

export function metricWindow(result,monitor,now) {
  const {count,maxAge,maxGap}=validateMonitor(monitor);
  const series=Array.isArray(result?.result)?result.result.flatMap(x=>Array.isArray(x.data)?x.data:[]):[];
  if(series.length!==1)throw new Error('Metric selector must yield exactly one aggregated series');
  const sample=series[0];
  if(!Array.isArray(sample.values)||!Array.isArray(sample.timestamps)||sample.values.length!==sample.timestamps.length||sample.values.length<count)throw new Error('Metric values and timestamps must be paired and complete');
  const values=sample.values.slice(-count),timestamps=sample.timestamps.slice(-count);
  if(values.some(x=>typeof x!=='number'||!Number.isFinite(x))||timestamps.some(x=>typeof x!=='number'||!Number.isFinite(x)))throw new Error('Metric samples need finite numeric values and timestamps');
  if(timestamps.some((time,index)=>time>now||time<now-900000||(index>0&&(time<=timestamps[index-1]||time-timestamps[index-1]>maxGap*1000)))||now-timestamps.at(-1)>maxAge*1000)throw new Error('Metric timestamps must be fresh, strictly increasing, and within the configured gap and query window');
  return {values,timestamps};
}
