const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
for(const args of [[],['--module','commonjs','--outDir','dist-cjs']]) { const r=spawnSync(process.execPath,[require.resolve('typescript/bin/tsc'),'-p','tsconfig.json',...args],{stdio:'inherit'}); if(r.status) process.exit(r.status); }
fs.writeFileSync('dist-cjs/package.json', JSON.stringify({type:'commonjs'}));
