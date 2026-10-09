// Match the original prose so an updated Skill keeps its new meaning and fixed resource identity.
const englishSkillIntroductions = new Map([
  ['从已有发票证据整理字段，并表达缺失、无法辨认和冲突；适用于具备发票复核工具的任务。', 'Organize fields from existing invoice evidence and report missing, unreadable, or conflicting information.'],
  ['需要核对净额、税额、总额、明细合计或舍入差异时，使用精确十进制工具并报告无法计算的条件。', 'Check net, tax, gross, and line totals with exact decimals, and report rounding differences or missing calculation inputs.'],
  ['需要比较同一任务的候选版本、字段变化或明细差异时，读取实际候选并说明来源、状态和未解决差别。', 'Compare candidate versions, field changes, and line differences within the same task, including sources, states, and unresolved differences.'],
  ['用户显式要求保存时，核验候选结构和来源，并依据真实保存回执报告候选身份。', 'When the user explicitly requests saving, verify candidate structure and sources, and report the identity confirmed by the actual save receipt.'],
  ['同一字段有多个证据值、买卖方归属冲突或跨材料结果不一致时，列出有来源的替代值及未解决条件。', 'Review conflicting field values, buyer and seller roles, or inconsistent evidence, preserving sourced alternatives and unresolved conditions.'],
  ['资料跨页、字段出处未知或需要定位明细表时，建立当前发票的证据地图并标明资料缺口。', 'Locate evidence across pages, identify field sources and line tables, and map gaps in the current invoice material.'],
  ['准备把已选候选用于表单前，复核字段、明细、来源及未解决问题，报告需要人工确认的条件。', 'Review fields, lines, sources, and unresolved issues before using the selected candidate in a form, and identify conditions needing human confirmation.'],
  ['需要整理发票号码、日期、买卖方、币种和头部金额时，区分原始值、规范化值及可核验来源。', 'Extract invoice number, date, buyer, seller, currency, and header amounts, distinguishing raw values, normalized values, and verifiable sources.'],
  ['明细表跨行、跨页或列映射不清时，整理商品、数量、单价及税额，并保留每行来源和未识别项。', 'Extract items, quantities, unit prices, and tax amounts from complex line tables, preserving each line source and unidentified content.'],
  ['字段缺失、资料无法辨认或不适用时，列出有依据的缺口及需要补充的信息，保留未知状态。', 'Review missing, unreadable, or inapplicable fields, and list evidence-backed gaps and information needed while preserving unknown values.'],
  ['需要复核候选字段引用、来源版本或原文是否支持字段时，核验当前冻结材料并区分有效来源与待确认项。', 'Verify source identities, document versions, and quoted evidence supporting candidate fields, distinguishing valid sources from items needing confirmation.'],
]);

export function skillIntroduction(description: string): string {
  return englishSkillIntroductions.get(description) ?? description;
}
