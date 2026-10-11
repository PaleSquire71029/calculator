/* 知行化学方程式配平核心：独立、可测试的精确整数求解器。 */
(function(root){
'use strict';
const gcd=(a,b)=>{a=a<0n?-a:a;b=b<0n?-b:b;while(b){const t=a%b;a=b;b=t;}return a||1n;};
const lcm=(a,b)=>a/gcd(a,b)*b;
const F=(n,d=1n)=>{if(d===0n)throw Error('内部错误：分母为零');if(d<0n){n=-n;d=-d;}const g=gcd(n,d);return {n:n/g,d:d/g};};
const add=(a,b)=>F(a.n*b.d+b.n*a.d,a.d*b.d),sub=(a,b)=>F(a.n*b.d-b.n*a.d,a.d*b.d),mul=(a,b)=>F(a.n*b.n,a.d*b.d),div=(a,b)=>F(a.n*b.d,a.d*b.n);
const zero=()=>F(0n),one=()=>F(1n);
function parseFormula(raw){
 let s=raw.trim();if(!s)throw Error('化学式不能为空');
 if(/^e[-−⁻]$/i.test(s))return {__charge:-1n};if(/^e[+＋⁺]$/i.test(s))return {__charge:1n};
 const sub={'₀':'0','₁':'1','₂':'2','₃':'3','₄':'4','₅':'5','₆':'6','₇':'7','₈':'8','₉':'9'},sup={'⁰':'0','¹':'1','²':'2','³':'3','⁴':'4','⁵':'5','⁶':'6','⁷':'7','⁸':'8','⁹':'9'};
 s=s.replace(/([⁰¹²³⁴⁵⁶⁷⁸⁹]*)([⁺⁻])$/,(_,d,z)=>'^'+Array.from(d).map(c=>sup[c]).join('')+(z==='⁻'?'-':'+'));
 s=s.replace(/[₀-₉]/g,c=>sub[c]).replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g,c=>sup[c]).replace(/[·⋅]/g,'.').replace(/−/g,'-').replace(/[［【\[]/g,'(').replace(/[］】\]]/g,')');
 if(!/\^[0-9]*[+-]$/.test(s))s=s.replace(/([+-])$/,'^$1');
 s=s.replace(/(?<!\^)(\d+)([+-])$/,'^$1$2');
 let charge=0n;const cm=s.match(/\^(\d*)([+-])$/);if(cm){charge=BigInt(cm[1]||'1')*(cm[2]==='-'?-1n:1n);s=s.slice(0,cm.index);}
 const merge=(a,b,k=1n)=>Object.keys(b).forEach(e=>a[e]=(a[e]||0n)+b[e]*k);
 function group(str){let i=0,stack=[{}];while(i<str.length){let ch=str[i];
 if(ch==='('){stack.push({});i++;continue;}
 if(ch===')'){if(stack.length===1)throw Error('括号不匹配：'+raw);i++;let d='';while(/\d/.test(str[i]||''))d+=str[i++];merge(stack[stack.length-2],stack.pop(),BigInt(d||'1'));continue;}
 if(/[A-Z]/.test(ch)){let e=ch;i++;while(/[a-z]/.test(str[i]||''))e+=str[i++];let d='';while(/\d/.test(str[i]||''))d+=str[i++];stack.at(-1)[e]=(stack.at(-1)[e]||0n)+BigInt(d||'1');continue;}
 throw Error('无法识别化学式：'+raw+'；请检查元素符号、括号及电荷写法。');}
 if(stack.length!==1)throw Error('括号不匹配：'+raw);return stack[0];}
 const atoms={};for(const piece0 of s.split('.')){if(!piece0)throw Error('结晶水/加合物写法不完整：'+raw);let piece=piece0,m=piece.match(/^(\d+)(?=[A-Z(])/),n=m?BigInt(m[1]):1n;if(m)piece=piece.slice(m[0].length);merge(atoms,group(piece),n);}
 atoms.__charge=charge;return atoms;
}
function splitTerms(side){const out=[];let start=0,depth=0;for(let i=0;i<side.length;i++){const c=side[i];if(c==='(')depth++;else if(c===')')depth--;else if(c==='+'&&depth===0){const prev=side.slice(start,i).trim(),next=side.slice(i+1).trim();if(!prev)throw Error('反应物之间存在空项');const spaced=(i>0&&/\s/.test(side[i-1]))||(i+1<side.length&&/\s/.test(side[i+1]));const ionic=/[⁺⁻]$/.test(prev)||/\^\d*[+-]$/.test(prev)||/^[+-]$/.test(next);if(ionic&&!spaced)continue;out.push(prev);start=i+1;}}const last=side.slice(start).trim();if(last)out.push(last);return out.map(v=>v.replace(/^\d+\s*(?=[A-Z(])/,'').trim());}
function solve(matrix,n){
 const a=matrix.map(row=>row.map(v=>F(v))),piv=[],R=a.length;let r=0;
 for(let c=0;c<n&&r<R;c++){let p=r;while(p<R&&a[p][c].n===0n)p++;if(p===R)continue;[a[r],a[p]]=[a[p],a[r]];const pv=a[r][c];a[r]=a[r].map(x=>div(x,pv));for(let rr=0;rr<R;rr++)if(rr!==r&&a[rr][c].n!==0n){const k=a[rr][c];a[rr]=a[rr].map((x,j)=>sub(x,mul(k,a[r][j])));}piv.push(c);r++;}
 for(let rr=0;rr<R;rr++)if(a[rr].every(x=>x.n===0n))continue;
 const free=Array.from({length:n},(_,i)=>i).filter(i=>!piv.includes(i));if(!free.length)throw Error('该方程没有非零配平解，请检查反应物和生成物。');
 let best=null,bestSum=null,nodes=0;const vals=Array(free.length).fill(1n),limit=free.length<=2?64:free.length===3?32:free.length===4?18:8;
 function gcdAll(v){return v.reduce((g,x)=>gcd(g,x),0n)||1n;}
 function consider(v){if(v.some(x=>x.n<=0n))return;let den=1n;v.forEach(x=>den=lcm(den,x.d));let z=v.map(x=>x.n*(den/x.d)),g=gcdAll(z);z=z.map(x=>x/g);if(z.some(x=>x<=0n))return;const sum=z.reduce((a,b)=>a+b,0n);if(bestSum===null||sum<bestSum){best=z;bestSum=sum;}}
 function walk(k){if(++nodes>250000)return;if(k===free.length){const v=Array.from({length:n},zero);free.forEach((fc,i)=>v[fc]=F(vals[i]));for(let rr=0;rr<piv.length;rr++){let sum=zero();free.forEach(fc=>sum=add(sum,mul(a[rr][fc],v[fc])));v[piv[rr]]=F(-sum.n,sum.d);}consider(v);return;}for(let x=1;x<=limit;x++){vals[k]=BigInt(x);walk(k+1);}}
 walk(0);
 if(!best)throw Error('在有限搜索范围内未找到正整数配平解。请核对产物/反应物；复杂多解反应可能需要更强的求解器。');
 return best;
}
function balance(raw){
 const normalized=raw.trim().replace(/⇌|⟶|→|⇒|＝|=/g,'->').replace(/−/g,'-'),sides=normalized.split(/->/);
 if(sides.length!==2)throw Error('请用 → 分隔反应物和生成物。');
 const left=splitTerms(sides[0]),right=splitTerms(sides[1]),forms=left.concat(right);
 if(!left.length||!right.length||forms.length>12)throw Error('请检查方程式；两侧都必须有物质，物质总数不能超过 12 种。');
 const parsed=forms.map(parseFormula),elements=[...new Set(parsed.flatMap(f=>Object.keys(f).filter(k=>k!=='__charge')))];
 if(parsed.some(f=>f.__charge!==0n))elements.push('__charge');
 const matrix=elements.map(el=>parsed.map((f,i)=>{const v=el==='__charge'?f.__charge:(f[el]||0n);return i<left.length?v:-v;}));
 const coeff=solve(matrix,forms.length);
 if(!matrix.every(row=>row.reduce((sum,v,i)=>sum+v*coeff[i],0n)===0n))throw Error('内部守恒校验失败，已阻止输出。');
 const pretty=f=>f.replace(/\.(\d+)/g,'·$1').replace(/([A-Za-z)])(\d+)/g,'$1<sub>$2</sub>').replace(/\^(\d*[+-])/g,'<sup>$1</sup>');
 return {equation:left.map((f,i)=>(coeff[i]===1n?'':coeff[i].toString())+pretty(f)).join(' + ')+' → '+right.map((f,i)=>(coeff[left.length+i]===1n?'':coeff[left.length+i].toString())+pretty(f)).join(' + '),coeff:coeff.map(String),elements};
}
root.ZXChemistryBalancer={balance,parseFormula};
})(typeof window!=='undefined'?window:globalThis);
