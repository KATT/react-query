---
'@tanstack/query-core': minor
'@tanstack/react-query': minor
---

Add experimental query handles. `experimental_queryHandle` and `experimental_queryHandleAsync` start a query from a query factory and return a small serializable handle: the first doesn't wait, and the second waits for fresh data. With `{ waitFor: 'cached' }`, `experimental_queryHandleAsync` uses any cached data, even if stale, and refetches stale data in the background. `experimental_fromHandle` rebuilds the query's options from a handle. `experimental_waterfallHandle` builds a handle for an input known only during render, and the component that reads it starts the query. `experimental_InferQueryHandleData` gives the type of the data a reader gets from a factory or handle.
