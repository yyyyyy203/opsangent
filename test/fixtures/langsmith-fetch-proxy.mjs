const endpointOrigin = 'https://api.smith.langchain.com';
const proxyOrigin = process.env.AGENTOPS_LANGSMITH_TEST_PROXY;
const originalFetch = globalThis.fetch.bind(globalThis);

if (proxyOrigin === undefined) throw new Error('TEST_PROXY_CONFIGURATION_MISSING');
const proxyUrl = new URL(proxyOrigin);
if (proxyUrl.protocol !== 'http:'
  || !['127.0.0.1', 'localhost', '[::1]'].includes(proxyUrl.hostname)
  || proxyUrl.username !== '' || proxyUrl.password !== ''
  || proxyUrl.pathname !== '/' || proxyUrl.search !== '' || proxyUrl.hash !== '') {
  throw new Error('TEST_PROXY_CONFIGURATION_INVALID');
}

globalThis.fetch = (input, init) => {
  const source = input instanceof Request ? input.url : String(input);
  const sourceUrl = new URL(source);
  if (sourceUrl.origin === endpointOrigin) {
    const targetUrl = new URL(`${sourceUrl.pathname}${sourceUrl.search}`, proxyUrl.origin);
    return originalFetch(targetUrl, init);
  }
  if (sourceUrl.origin === proxyUrl.origin) return originalFetch(input, init);
  throw new Error('TEST_PROXY_ORIGIN_REJECTED');
};
