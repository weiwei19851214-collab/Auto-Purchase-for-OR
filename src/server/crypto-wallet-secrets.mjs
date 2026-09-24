// 助记词只在当前 Node 进程内按 job/CSV 行号暂存；数据库、任务 CSV 和结果文件均不持有它。
const jobSeeds = new Map();

export function validateWalletSeedRows(seedPhrases, planRows) {
  if (seedPhrases === undefined) return null;
  if (!Array.isArray(seedPhrases) || seedPhrases.length !== planRows.length) {
    throw new Error('虚拟币助记词与任务行数不一致，请重新上传 CSV');
  }
  const normalized = seedPhrases.map((phrase, index) => {
    const value = String(phrase || '').trim();
    if (!/^[a-z]+(?: [a-z]+){11}$/i.test(value)) {
      throw new Error('虚拟币 CSV 第 ' + (index + 2) + ' 行助记词格式无效');
    }
    return value;
  });
  // 所有账号共用同一钱包；不同助记词意味着可能导入了错误的钱包，不能继续。
  if (normalized.some((phrase) => phrase !== normalized[0])) {
    throw new Error('虚拟币 CSV 的助记词必须对应同一个 OKX 钱包');
  }
  return normalized;
}

export function holdWalletSeeds(jobId, seedPhrases) {
  if (seedPhrases) jobSeeds.set(jobId, seedPhrases);
}

export function walletSeedForRow(jobId, rawIndex) {
  return jobSeeds.get(jobId)?.[rawIndex] || '';
}

export function clearWalletSeeds(jobId) {
  jobSeeds.delete(jobId);
}
