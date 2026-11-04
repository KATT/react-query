import {
  QueryClient,
  QueryObserver,
  defaultShouldDehydrateQuery,
  dehydrate,
  hydrate,
} from '@tanstack/query-core'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const queryKey = ['post', 1]

// 🖥️ Server: the query is still pending at dehydrate, and rejects later
const serverClient = new QueryClient({
  defaultOptions: {
    dehydrate: {
      // include pending queries in dehydration, as in the Advanced SSR guide
      shouldDehydrateQuery: (query) =>
        defaultShouldDehydrateQuery(query) || query.state.status === 'pending',
    },
  },
})
serverClient
  .query({
    queryKey,
    queryFn: () => sleep(10).then(() => Promise.reject(new Error('server error'))),
    retry: false,
  })
  .catch(() => {})
const dehydratedState = dehydrate(serverClient)

// 🌐 Browser: retries are off by default, so we can see whether the reader's option wins
const browserClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
})
hydrate(browserClient, dehydratedState)

// 👀 This reader asks for 1 retry
const observer = new QueryObserver(browserClient, {
  queryKey,
  queryFn: () => sleep(10).then(() => 'data from the browser'),
  retry: 1,
  retryDelay: 10,
})
observer.subscribe(() => {})

await sleep(500)
const { status, data, error } = browserClient.getQueryState(queryKey)
console.log({ status, data, error: error?.message })
// ✅ Expected: { status: 'success', data: 'data from the browser', error: undefined }
// 🐛 Actual on 5.106.0: { status: 'error', data: undefined, error: 'redacted' }
process.exit(0)
