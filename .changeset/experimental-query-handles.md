---
'@tanstack/query-core': minor
'@tanstack/react-query': minor
---

Add experimental query handles. `experimental_queryHandle` starts a query from a query factory and returns a small serializable handle, with a promise that resolves with the handle once the query has data. It takes a `staleTime` for one call: with `{ staleTime: 'static' }`, it uses any cached data, even if stale. `experimental_fromHandle` rebuilds the query's options from a handle. `experimental_waterfallHandle` builds a handle for an input known only during render, and the component that reads it starts the query. `experimental_InferQueryHandleData` gives the type of the data a reader gets from a factory or handle.
