/* 知行计算器：规则驱动的化学反应候选引擎
 * 面向常见初高中反应；不是量子化学/通用反应预测器。多候选并列展示，条件不足时明确提示。
 */
(function (root) {
  'use strict';
  const sub = {'₀':'0','₁':'1','₂':'2','₃':'3','₄':'4','₅':'5','₆':'6','₇':'7','₈':'8','₉':'9'};
  const norm = s => String(s || '').replace(/[₀-₉]/g, c => sub[c]).replace(/[⁺]/g,'+').replace(/[⁻]/g,'-').replace(/\s+/g,'').replace(/[（]/g,'(').replace(/[）]/g,')');
  const canonical = s => norm(s).replace(/\(aq\)|\(s\)|\(g\)|\(l\)/gi,'').toLowerCase();
  const sortKey = xs => xs.map(canonical).sort().join('+');
  const db = [];
  function add(reactants, equation, label, conditions, confidence) {
    db.push({reactants:reactants.map(canonical), equation, label, conditions:conditions||'常规条件', confidence:confidence||'常见反应规则'});
  }
  // 单物质分解：条件在标签中明确注明。
  [
    [['KClO3'],'KClO3 → KCl + O2','氯酸钾分解','加热，通常用 MnO2 催化'],
    [['H2O2'],'H2O2 → H2O + O2','过氧化氢分解','催化剂或适当条件'],
    [['CaCO3'],'CaCO3 → CaO + CO2','碳酸钙分解','高温煅烧'],
    [['NaHCO3'],'NaHCO3 → Na2CO3 + CO2 + H2O','碳酸氢钠受热分解','加热'],
    [['KMnO4'],'KMnO4 → K2MnO4 + MnO2 + O2','高锰酸钾分解','加热'],
    [['Cu(OH)2'],'Cu(OH)2 → CuO + H2O','氢氧化铜分解','加热'],
    [['Fe(OH)3'],'Fe(OH)3 → Fe2O3 + H2O','氢氧化铁分解','加热'],
    [['Ag2O'],'Ag2O → Ag + O2','氧化银分解','加热'],
    [['HgO'],'HgO → Hg + O2','氧化汞分解','加热']
  ].forEach(x=>add(x[0],x[1],x[2],x[3]));
  // 合成、燃烧与氧化的条件分支。
  [
    [['H2','O2'],'H2 + O2 → H2O','氢气燃烧','点燃；放出大量热'],
    [['C','O2'],'C + O2 → CO2','碳完全燃烧','氧气充足；点燃'],
    [['C','O2'],'C + O2 → CO','碳不完全燃烧','氧气不足；条件影响产物','条件敏感'],
    [['S','O2'],'S + O2 → SO2','硫燃烧','点燃'],
    [['P','O2'],'P + O2 → P2O5','磷燃烧','点燃；常用经验式 P2O5'],
    [['Mg','O2'],'Mg + O2 → MgO','镁燃烧','点燃'],
    [['Al','O2'],'Al + O2 → Al2O3','铝与氧气反应','点燃/加热'],
    [['Fe','O2'],'Fe + O2 → Fe3O4','铁在氧气中燃烧','铁丝在氧气中燃烧的常见产物'],
    [['Fe','O2'],'Fe + O2 → Fe2O3','铁氧化形成氧化铁','其他氧化条件；需核对实际产物','条件敏感'],
    [['Cu','O2'],'Cu + O2 → CuO','铜氧化','加热；条件不同可能有 Cu2O'],
    [['CH4','O2'],'CH4 + O2 → CO2 + H2O','甲烷完全燃烧','氧气充足'],
    [['CH4','O2'],'CH4 + O2 → CO + H2O','甲烷不完全燃烧','氧气不足','条件敏感'],
    [['C2H5OH','O2'],'C2H5OH + O2 → CO2 + H2O','乙醇完全燃烧','氧气充足'],
    [['CO','O2'],'CO + O2 → CO2','一氧化碳氧化','氧气充足/点燃'],
    [['SO2','O2'],'SO2 + O2 → SO3','二氧化硫氧化','催化剂、加热；可逆反应需结合条件'],
    [['N2','H2'],'N2 + H2 → NH3','合成氨','高温、高压、铁催化剂；可逆反应'],
    [['CaO','H2O'],'CaO + H2O → Ca(OH)2','生石灰与水化合','放热'],
    [['Na2O','H2O'],'Na2O + H2O → NaOH','氧化钠与水反应','常规条件'],
    [['CO2','H2O'],'CO2 + H2O → H2CO3','二氧化碳溶于水','可逆，生成少量碳酸']
  ].forEach(x=>add(x[0],x[1],x[2],x[3],x[4]));
  // 活泼金属与水/酸。
  [
    [['Na','H2O'],'Na + H2O → NaOH + H2','钠与水反应','常温；剧烈'],
    [['K','H2O'],'K + H2O → KOH + H2','钾与水反应','常温；极剧烈'],
    [['Ca','H2O'],'Ca + H2O → Ca(OH)2 + H2','钙与水反应','常温'],
    [['Mg','H2O'],'Mg + H2O → Mg(OH)2 + H2','镁与热水反应','热水；冷水中很慢','条件敏感'],
    [['Mg','HCl'],'Mg + HCl → MgCl2 + H2','镁与盐酸反应','稀盐酸'],
    [['Zn','HCl'],'Zn + HCl → ZnCl2 + H2','锌与盐酸反应','稀盐酸'],
    [['Fe','HCl'],'Fe + HCl → FeCl2 + H2','铁与稀盐酸反应','稀盐酸；生成亚铁盐'],
    [['Al','HCl'],'Al + HCl → AlCl3 + H2','铝与盐酸反应','除去氧化膜后反应'],
    [['Mg','H2SO4'],'Mg + H2SO4 → MgSO4 + H2','镁与稀硫酸反应','稀硫酸'],
    [['Zn','H2SO4'],'Zn + H2SO4 → ZnSO4 + H2','锌与稀硫酸反应','稀硫酸'],
    [['Fe','H2SO4'],'Fe + H2SO4 → FeSO4 + H2','铁与稀硫酸反应','稀硫酸；不适用于浓硫酸'],
    [['Zn','CuSO4'],'Zn + CuSO4 → ZnSO4 + Cu','锌置换铜','溶液中'],
    [['Fe','CuSO4'],'Fe + CuSO4 → FeSO4 + Cu','铁置换铜','溶液中'],
    [['Cu','AgNO3'],'Cu + AgNO3 → Cu(NO3)2 + Ag','铜置换银','溶液中'],
    [['Al','CuSO4'],'Al + CuSO4 → Al2(SO4)3 + Cu','铝置换铜','需注意铝表面氧化膜，实际速率受影响']
  ].forEach(x=>add(x[0],x[1],x[2],x[3]));
  // 酸碱中和与酸和盐/氧化物。
  [
    [['HCl','NaOH'],'HCl + NaOH → NaCl + H2O','盐酸与氢氧化钠中和','水溶液'],
    [['H2SO4','NaOH'],'H2SO4 + NaOH → Na2SO4 + H2O','硫酸与氢氧化钠中和','完全中和；酸碱比例需配平'],
    [['HNO3','NaOH'],'HNO3 + NaOH → NaNO3 + H2O','硝酸与氢氧化钠中和','水溶液'],
    [['HCl','KOH'],'HCl + KOH → KCl + H2O','盐酸与氢氧化钾中和','水溶液'],
    [['H2SO4','KOH'],'H2SO4 + KOH → K2SO4 + H2O','硫酸与氢氧化钾中和','完全中和'],
    [['HCl','Ca(OH)2'],'HCl + Ca(OH)2 → CaCl2 + H2O','盐酸与氢氧化钙中和','完全中和'],
    [['H2SO4','Ba(OH)2'],'H2SO4 + Ba(OH)2 → BaSO4 + H2O','硫酸与氢氧化钡反应','生成沉淀和水'],
    [['HCl','CuO'],'HCl + CuO → CuCl2 + H2O','盐酸与碱性氧化物反应','酸足量'],
    [['H2SO4','CuO'],'H2SO4 + CuO → CuSO4 + H2O','硫酸与氧化铜反应','酸足量'],
    [['HCl','CaCO3'],'HCl + CaCO3 → CaCl2 + CO2 + H2O','盐酸与碳酸钙反应','酸足量'],
    [['HCl','Na2CO3'],'HCl + Na2CO3 → NaCl + CO2 + H2O','盐酸与碳酸钠反应','酸足量；酸式盐比例不同会影响产物'],
    [['HCl','NaHCO3'],'HCl + NaHCO3 → NaCl + CO2 + H2O','盐酸与碳酸氢钠反应','酸足量'],
    [['H2SO4','Na2CO3'],'H2SO4 + Na2CO3 → Na2SO4 + CO2 + H2O','硫酸与碳酸钠反应','酸足量'],
    [['HCl','Fe2O3'],'HCl + Fe2O3 → FeCl3 + H2O','盐酸与氧化铁反应','酸足量'],
    [['H2SO4','ZnO'],'H2SO4 + ZnO → ZnSO4 + H2O','硫酸与氧化锌反应','酸足量']
  ].forEach(x=>add(x[0],x[1],x[2],x[3]));
  // 复分解/沉淀反应。
  [
    [['AgNO3','NaCl'],'AgNO3 + NaCl → AgCl + NaNO3','生成氯化银沉淀','水溶液'],
    [['BaCl2','Na2SO4'],'BaCl2 + Na2SO4 → BaSO4 + NaCl','生成硫酸钡沉淀','水溶液'],
    [['CuSO4','NaOH'],'CuSO4 + NaOH → Cu(OH)2 + Na2SO4','生成蓝色氢氧化铜沉淀','水溶液'],
    [['FeCl3','NaOH'],'FeCl3 + NaOH → Fe(OH)3 + NaCl','生成红褐色氢氧化铁沉淀','水溶液'],
    [['FeSO4','NaOH'],'FeSO4 + NaOH → Fe(OH)2 + Na2SO4','生成氢氧化亚铁沉淀','新制沉淀易被氧化'],
    [['CaCl2','Na2CO3'],'CaCl2 + Na2CO3 → CaCO3 + NaCl','生成碳酸钙沉淀','水溶液'],
    [['BaCl2','Na2CO3'],'BaCl2 + Na2CO3 → BaCO3 + NaCl','生成碳酸钡沉淀','水溶液'],
    [['Pb(NO3)2','KI'],'Pb(NO3)2 + KI → PbI2 + KNO3','生成黄色碘化铅沉淀','水溶液'],
    [['Na2SO4','Ba(NO3)2'],'Na2SO4 + Ba(NO3)2 → BaSO4 + NaNO3','生成硫酸钡沉淀','水溶液'],
    [['NH4Cl','NaOH'],'NH4Cl + NaOH → NaCl + NH3 + H2O','铵盐与强碱反应','加热更易逸出氨气'],
    [['NH4NO3','NaOH'],'NH4NO3 + NaOH → NaNO3 + NH3 + H2O','铵盐与强碱反应','加热更易逸出氨气']
  ].forEach(x=>add(x[0],x[1],x[2],x[3]));
  // 常见还原反应。
  [
    [['CuO','H2'],'CuO + H2 → Cu + H2O','氢气还原氧化铜','加热'],
    [['Fe2O3','CO'],'Fe2O3 + CO → Fe + CO2','一氧化碳还原氧化铁','高温'],
    [['CuO','C'],'CuO + C → Cu + CO2','碳还原氧化铜','高温；产物受比例/条件影响'],
    [['Fe2O3','Al'],'Fe2O3 + Al → Al2O3 + Fe','铝热反应','高温引发；危险实验，不应自行操作'],
    [['C','H2O'],'C + H2O → CO + H2','碳与水蒸气反应','高温水蒸气']
  ].forEach(x=>add(x[0],x[1],x[2],x[3]));
  function predict(input, options) {
    options=options||{};
    const raw=String(input||'').trim();
    if(!raw) return {ok:false,message:'请先输入反应物。',candidates:[]};
    if(/(?:->|→|⟶|⇒|⇌|＝|=)/.test(raw)) return {ok:false,message:'请只输入反应物，不要输入箭头或已有生成物。',candidates:[]};
    const parts=raw.split('+').map(s=>s.trim()).filter(Boolean);
    if(!parts.length||parts.some(s=>!s)) return {ok:false,message:'请用 + 分隔反应物，例如：Zn + HCl。',candidates:[]};
    const key=sortKey(parts);
    const candidates=db.filter(r=>sortKey(r.reactants)===key).map((r,i)=>Object.assign({id:i,score:r.confidence==='条件敏感'?0.65:0.9},r));
    // 额外明确提示：硝酸/浓硫酸具有氧化性，不能套用普通酸与金属放氢规则。
    const acidSensitive=parts.some(x=>/^HNO3$/i.test(canonical(x))||/^H2SO4$/i.test(canonical(x)));
    const metal=parts.some(x=>/^(Mg|Al|Zn|Fe|Cu|Ag)$/i.test(canonical(x)));
    const warnings=[];
    if(acidSensitive&&metal) warnings.push('硝酸及浓硫酸具有氧化性，金属反应产物与浓度、温度有关，不能简单按“酸 + 金属 → 盐 + 氢气”判断。');
    if(candidates.length) return {ok:true,message:'匹配到 '+candidates.length+' 个规则候选。请根据试剂浓度、温度、氧气量及实验现象选择。',candidates,warnings};
    // 对明显的常见类型提供有边界的诊断，不凭空生成未知产物。
    let message='暂未找到与这组反应物完全匹配的内置规则。可检查化学式、补充条件，或手动输入生成物后配平。';
    if(parts.some(x=>/^HNO3$/i.test(canonical(x)))) message='含硝酸的反应常受浓度、温度和氧化还原条件影响；当前规则库不自动猜测产物，请补充条件或查阅对应反应。';
    else if(parts.length===2&&parts.some(x=>/^O2$/i.test(canonical(x)))) message='检测到含氧气反应，但无法仅凭反应物可靠判断完全燃烧、部分氧化或其他产物；请补充氧气量、温度及反应对象。';
    return {ok:false,message,candidates:[],warnings};
  }
  root.ZXChemistryPredictor={predict,ruleCount:db.length};
})(typeof window!=='undefined'?window:globalThis);
