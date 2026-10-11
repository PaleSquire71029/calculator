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

  // 扩展规则库：初高中常见物质制备、分解、酸碱盐、氧化还原与气体反应。
  // 规则仅在反应物集合完全匹配时触发；同一反应的条件分支可以并列返回。
  [
    [['H2CO3'],'H2CO3 → CO2 + H2O','碳酸分解','常温下不稳定'],
    [['H2SO3'],'H2SO3 → SO2 + H2O','亚硫酸分解','不稳定酸'],
    [['NH4HCO3'],'NH4HCO3 → NH3 + CO2 + H2O','碳酸氢铵分解','加热'],
    [['(NH4)2CO3'],'(NH4)2CO3 → NH3 + CO2 + H2O','碳酸铵分解','加热'],
    [['Cu(NO3)2'],'Cu(NO3)2 → CuO + NO2 + O2','硝酸铜热分解','加热'],
    [['AgNO3'],'AgNO3 → Ag + NO2 + O2','硝酸银热分解','加热'],
    [['Pb(NO3)2'],'Pb(NO3)2 → PbO + NO2 + O2','硝酸铅热分解','加热'],
    [['NH4Cl'],'NH4Cl → NH3 + HCl','氯化铵受热分解/升华','受热时存在可逆解离，不能简单视为普通稳定分解'],
    [['ZnCO3'],'ZnCO3 → ZnO + CO2','碳酸锌分解','加热'],
    [['CuCO3'],'CuCO3 → CuO + CO2','碱式碳酸铜相关分解','加热；实际常见物质可能为 Cu2(OH)2CO3'],
    [['Al(OH)3'],'Al(OH)3 → Al2O3 + H2O','氢氧化铝分解','加热'],
    [['Mg(OH)2'],'Mg(OH)2 → MgO + H2O','氢氧化镁分解','加热'],
    [['Zn(OH)2'],'Zn(OH)2 → ZnO + H2O','氢氧化锌分解','加热'],
    [['H2O'],'H2O → H2 + O2','水电解','通电；输入按 H2O 表示，配平时由配平器处理'],
    [['NaClO3'],'NaClO3 → NaCl + O2','氯酸钠分解','加热；实际应用须遵守实验安全要求']
  ].forEach(x=>add(x[0],x[1],x[2],x[3]));
  [
    [['H2','Cl2'],'H2 + Cl2 → HCl','氢气与氯气化合','光照或点燃；反应剧烈'],
    [['Fe','Cl2'],'Fe + Cl2 → FeCl3','铁与氯气反应','点燃；氯气氧化性较强'],
    [['Cu','Cl2'],'Cu + Cl2 → CuCl2','铜与氯气反应','加热/点燃'],
    [['Na','Cl2'],'Na + Cl2 → NaCl','钠与氯气化合','点燃'],
    [['Al','Cl2'],'Al + Cl2 → AlCl3','铝与氯气反应','点燃'],
    [['P','Cl2'],'P + Cl2 → PCl3','磷与氯气反应生成三氯化磷','氯气不足等条件；条件敏感'],
    [['P','Cl2'],'P + Cl2 → PCl5','磷与氯气反应生成五氯化磷','氯气充足；条件敏感'],
    [['Na2O','CO2'],'Na2O + CO2 → Na2CO3','氧化钠与二氧化碳反应','常规条件'],
    [['CaO','CO2'],'CaO + CO2 → CaCO3','氧化钙与二氧化碳反应','常规条件'],
    [['Na2O','HCl'],'Na2O + HCl → NaCl + H2O','氧化钠与盐酸反应','酸足量'],
    [['CaO','HCl'],'CaO + HCl → CaCl2 + H2O','氧化钙与盐酸反应','酸足量'],
    [['MgO','HCl'],'MgO + HCl → MgCl2 + H2O','氧化镁与盐酸反应','酸足量'],
    [['Al2O3','HCl'],'Al2O3 + HCl → AlCl3 + H2O','氧化铝与盐酸反应','酸足量'],
    [['Al2O3','NaOH'],'Al2O3 + NaOH → NaAlO2 + H2O','氧化铝与氢氧化钠反应','高温熔融或适当条件；水溶液中常写偏铝酸根形式'],
    [['ZnO','NaOH'],'ZnO + NaOH → Na2ZnO2 + H2O','氧化锌与氢氧化钠反应','高温熔融；水溶液物种形式不同'],
    [['CO2','NaOH'],'CO2 + NaOH → Na2CO3 + H2O','二氧化碳与氢氧化钠反应','氢氧化钠足量；比例影响产物'],
    [['CO2','NaOH'],'CO2 + NaOH → NaHCO3','二氧化碳与氢氧化钠反应生成碳酸氢钠','二氧化碳过量；条件敏感'],
    [['SO2','NaOH'],'SO2 + NaOH → Na2SO3 + H2O','二氧化硫与氢氧化钠反应','碱足量'],
    [['SO2','NaOH'],'SO2 + NaOH → NaHSO3','二氧化硫与氢氧化钠生成亚硫酸氢钠','二氧化硫过量；条件敏感'],
    [['SO3','H2O'],'SO3 + H2O → H2SO4','三氧化硫与水反应','放热；需注意安全'],
    [['SO2','H2O2'],'SO2 + H2O2 → H2SO4','二氧化硫被过氧化氢氧化','适当条件'],
    [['NO2','H2O'],'NO2 + H2O → HNO3 + NO','二氧化氮与水反应','常温；混合产物'],
    [['CaO','SiO2'],'CaO + SiO2 → CaSiO3','氧化钙与二氧化硅反应','高温'],
    [['CaCO3','SiO2'],'CaCO3 + SiO2 → CaSiO3 + CO2','碳酸钙与二氧化硅反应','高温'],
    [['Fe2O3','CO'],'Fe2O3 + CO → FeO + CO2','氧化铁被一氧化碳部分还原','条件与比例影响产物；条件敏感']
  ].forEach(x=>add(x[0],x[1],x[2],x[3],x[4]));
  [
    [['Na2CO3','Ca(OH)2'],'Na2CO3 + Ca(OH)2 → CaCO3 + NaOH','纯碱苛化反应','水溶液；生成沉淀'],
    [['Na2SO4','BaCl2'],'Na2SO4 + BaCl2 → BaSO4 + NaCl','生成硫酸钡沉淀','水溶液'],
    [['K2SO4','BaCl2'],'K2SO4 + BaCl2 → BaSO4 + KCl','生成硫酸钡沉淀','水溶液'],
    [['AgNO3','KCl'],'AgNO3 + KCl → AgCl + KNO3','生成氯化银沉淀','水溶液'],
    [['AgNO3','KBr'],'AgNO3 + KBr → AgBr + KNO3','生成淡黄色溴化银沉淀','水溶液'],
    [['AgNO3','KI'],'AgNO3 + KI → AgI + KNO3','生成黄色碘化银沉淀','水溶液'],
    [['Ba(OH)2','CuSO4'],'Ba(OH)2 + CuSO4 → BaSO4 + Cu(OH)2','生成硫酸钡和氢氧化铜沉淀','水溶液'],
    [['Ba(OH)2','Na2SO4'],'Ba(OH)2 + Na2SO4 → BaSO4 + NaOH','生成硫酸钡沉淀','水溶液'],
    [['Ca(OH)2','Na2CO3'],'Ca(OH)2 + Na2CO3 → CaCO3 + NaOH','石灰水与碳酸钠反应','水溶液'],
    [['Ca(OH)2','CO2'],'Ca(OH)2 + CO2 → CaCO3 + H2O','二氧化碳使澄清石灰水变浑浊','二氧化碳适量'],
    [['Ca(OH)2','CO2'],'Ca(OH)2 + CO2 → Ca(HCO3)2','碳酸钙沉淀溶解','二氧化碳过量且有水；条件敏感'],
    [['CaCO3','CO2','H2O'],'CaCO3 + CO2 + H2O → Ca(HCO3)2','碳酸钙转化为可溶性碳酸氢钙','二氧化碳和水存在'],
    [['CuSO4','Fe'],'Fe + CuSO4 → FeSO4 + Cu','铁置换铜','水溶液'],
    [['CuCl2','Zn'],'Zn + CuCl2 → ZnCl2 + Cu','锌置换铜','水溶液'],
    [['FeCl2','Zn'],'Zn + FeCl2 → ZnCl2 + Fe','锌置换铁','水溶液'],
    [['AgNO3','Fe'],'Fe + AgNO3 → Fe(NO3)2 + Ag','铁置换银','硝酸银溶液，铁通常生成亚铁盐'],
    [['CuO','H2SO4'],'CuO + H2SO4 → CuSO4 + H2O','氧化铜与硫酸反应','酸足量'],
    [['FeO','HCl'],'FeO + HCl → FeCl2 + H2O','氧化亚铁与盐酸反应','酸足量'],
    [['Fe3O4','HCl'],'Fe3O4 + HCl → FeCl2 + FeCl3 + H2O','四氧化三铁与盐酸反应','酸足量'],
    [['Na2SO3','HCl'],'Na2SO3 + HCl → NaCl + SO2 + H2O','亚硫酸盐与酸反应','酸足量'],
    [['Na2S','HCl'],'Na2S + HCl → NaCl + H2S','硫化物与酸反应','通风橱等专业条件；H2S 有毒'],
    [['FeS','HCl'],'FeS + HCl → FeCl2 + H2S','硫化亚铁与盐酸反应','实验室制硫化氢涉及有毒气体，不应自行操作'],
    [['Na2SiO3','HCl'],'Na2SiO3 + HCl → NaCl + H2SiO3','硅酸钠与盐酸反应','生成胶状硅酸沉淀'],
    [['NaAlO2','HCl'],'NaAlO2 + HCl + H2O → Al(OH)3 + NaCl','偏铝酸钠与盐酸反应','盐酸适量；过量酸时沉淀可溶解'],
    [['AlCl3','NaOH'],'AlCl3 + NaOH → Al(OH)3 + NaCl','铝盐与少量强碱反应','NaOH 不过量；过量时沉淀溶解'],
    [['AlCl3','NaOH'],'AlCl3 + NaOH → NaAlO2 + NaCl + H2O','铝盐与过量强碱反应','NaOH 过量；条件敏感'],
    [['ZnCl2','NaOH'],'ZnCl2 + NaOH → Zn(OH)2 + NaCl','锌盐与少量强碱反应','NaOH 不过量'],
    [['ZnCl2','NaOH'],'ZnCl2 + NaOH → Na2ZnO2 + NaCl + H2O','锌盐与过量强碱反应','过量强碱；水溶液常用锌酸根表示'],
    [['NH4Cl','Ca(OH)2'],'NH4Cl + Ca(OH)2 → CaCl2 + NH3 + H2O','铵盐与碱放出氨气','加热'],
    [['NH4NO3','Ca(OH)2'],'NH4NO3 + Ca(OH)2 → Ca(NO3)2 + NH3 + H2O','铵盐与碱放出氨气','加热']
  ].forEach(x=>add(x[0],x[1],x[2],x[3],x[4]));
  [
    [['Zn','H2O'],'Zn + H2O → ZnO + H2','锌与水蒸气反应','高温水蒸气'],
    [['Fe','H2O'],'Fe + H2O → Fe3O4 + H2','铁与水蒸气反应','高温水蒸气'],
    [['Al','H2O'],'Al + H2O → Al2O3 + H2','铝与水蒸气反应','高温；氧化膜影响反应'],
    [['Na2O2','H2O'],'Na2O2 + H2O → NaOH + O2','过氧化钠与水反应','同时生成 H2O2 中间物种，整体反应式为简化表示'],
    [['Na2O2','CO2'],'Na2O2 + CO2 → Na2CO3 + O2','过氧化钠与二氧化碳反应','常见供氧反应'],
    [['Cl2','H2O'],'Cl2 + H2O ⇌ HCl + HClO','氯气与水反应','可逆反应；光照下次氯酸分解'],
    [['Cl2','NaOH'],'Cl2 + NaOH → NaCl + NaClO + H2O','氯气与冷稀氢氧化钠反应','冷、稀碱液'],
    [['Cl2','NaOH'],'Cl2 + NaOH → NaCl + NaClO3 + H2O','氯气与热浓氢氧化钠反应','热、浓碱液；条件敏感'],
    [['MnO2','HCl'],'MnO2 + HCl → MnCl2 + Cl2 + H2O','二氧化锰氧化浓盐酸','浓盐酸、加热；会产生有毒氯气'],
    [['Cu','HNO3'],'Cu + HNO3 → Cu(NO3)2 + NO2 + H2O','铜与浓硝酸反应','浓硝酸；有毒氮氧化物'],
    [['Cu','HNO3'],'Cu + HNO3 → Cu(NO3)2 + NO + H2O','铜与稀硝酸反应','稀硝酸；有毒氮氧化物'],
    [['Cu','H2SO4'],'Cu + H2SO4 → CuSO4 + SO2 + H2O','铜与浓硫酸反应','浓硫酸、加热；不生成氢气'],
    [['Fe2O3','H2'],'Fe2O3 + H2 → Fe + H2O','氢气还原氧化铁','高温'],
    [['PbO','C'],'PbO + C → Pb + CO2','碳还原氧化铅','高温'],
    [['CuO','CO'],'CuO + CO → Cu + CO2','一氧化碳还原氧化铜','加热'],
    [['NO','O2'],'NO + O2 → NO2','一氧化氮氧化','常温接触氧气'],
    [['NH3','O2'],'NH3 + O2 → NO + H2O','氨的催化氧化','Pt-Rh 催化剂、高温'],
    [['NH3','O2'],'NH3 + O2 → N2 + H2O','氨气燃烧生成氮气','无催化剂等特定条件；条件敏感'],
    [['N2','O2'],'N2 + O2 → NO','氮气与氧气化合','高温/放电'],
    [['H2S','O2'],'H2S + O2 → SO2 + H2O','硫化氢完全燃烧','氧气充足；H2S 有毒'],
    [['H2S','O2'],'H2S + O2 → S + H2O','硫化氢不完全燃烧','氧气不足；条件敏感'],
    [['SO2','H2S'],'SO2 + H2S → S + H2O','二氧化硫与硫化氢氧化还原','常见氧化还原反应'],
    [['FeCl3','Cu'],'FeCl3 + Cu → FeCl2 + CuCl2','氯化铁氧化铜','水溶液；氧化还原'],
    [['Cl2','KI'],'Cl2 + KI → KCl + I2','氯气置换碘','水溶液；卤素氧化性比较'],
    [['Br2','KI'],'Br2 + KI → KBr + I2','溴置换碘','水溶液；卤素氧化性比较'],
    [['Cl2','KBr'],'Cl2 + KBr → KCl + Br2','氯气置换溴','水溶液；卤素氧化性比较'],
    [['Na','O2'],'Na + O2 → Na2O','钠在氧气中生成氧化钠','氧气量/条件影响；条件敏感'],
    [['Na','O2'],'Na + O2 → Na2O2','钠在氧气中生成过氧化钠','氧气充足等条件；条件敏感'],
    [['Ca','O2'],'Ca + O2 → CaO','钙燃烧','点燃'],
    [['Zn','O2'],'Zn + O2 → ZnO','锌燃烧/氧化','加热'],
    [['Hg','S'],'Hg + S → HgS','汞与硫反应','常规条件；用于说明汞的化学固定，不应直接操作汞'],
    [['Fe','S'],'Fe + S → FeS','铁与硫化合','加热'],
    [['H2','S'],'H2 + S → H2S','氢气与硫化合','加热；硫化氢有毒'],
    [['CaC2','H2O'],'CaC2 + H2O → C2H2 + Ca(OH)2','电石与水制乙炔','遇水放出可燃气体，专业操作'],
    [['Al4C3','H2O'],'Al4C3 + H2O → CH4 + Al(OH)3','碳化铝水解制甲烷','常规条件'],
    [['Ca3N2','H2O'],'Ca3N2 + H2O → NH3 + Ca(OH)2','氮化钙水解','常规条件'],
    [['Mg3N2','H2O'],'Mg3N2 + H2O → NH3 + Mg(OH)2','氮化镁水解','常规条件']
  ].forEach(x=>add(x[0],x[1],x[2],x[3],x[4]));

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
  root.ZXChemistryPredictor={predict,ruleCount:db.length,version:'2.0-expanded'};
})(typeof window!=='undefined'?window:globalThis);
