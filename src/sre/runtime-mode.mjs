// Both development modes use synthetic identities and simulated deployment
// dispatch. Trial mode permits Claude inference; local mode stays offline.
export const isSimulationMode=mode=>mode==='local'||mode==='trial';
