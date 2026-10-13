export function telegramCredentials(env = process.env) {
  const apiId = Number(env.TELOPOTIFY_API_ID);
  const apiHash = env.TELOPOTIFY_API_HASH;
  if (!Number.isSafeInteger(apiId) || apiId < 1 || apiId > 2_147_483_647 || typeof apiHash !== 'string' || !/^[a-f0-9]{32}$/i.test(apiHash)) {
    throw new Error('Configure TELOPOTIFY_API_ID and TELOPOTIFY_API_HASH from your Telegram application before starting');
  }
  return {apiId, apiHash};
}
