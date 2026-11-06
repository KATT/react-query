---
'@tanstack/query-core': minor
'@tanstack/react-query': minor
---

Add experimental query handles. `experimental_loadQueryHandles` starts a loader's queries from query factories and returns a small serializable handle for each. Its callback starts every query before anything waits: `load.start` doesn't wait, `load.wait` waits for fresh data, `load.ensure` waits for any data, even if it is stale, and `load.after` starts a query that needs another query's data as soon as that data is in the cache. It resolves to the handles and to the data of the queries it waited for. `experimental_fromHandle` rebuilds a query's options from its handle. `experimental_waterfallHandle` builds a handle for an input known only during render, and the component that reads it starts the query. `experimental_InferQueryHandleData` gives the type of the data a reader gets from a factory or handle.
