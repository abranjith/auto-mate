import { formatDoctor, runDoctor } from './doctor';

const report = runDoctor();
console.log(formatDoctor(report));
if (!report.ok) process.exitCode = 1;
