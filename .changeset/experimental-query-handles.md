---
'@tanstack/query-core': minor
'@tanstack/react-query': minor
---

Add experimental query handles. `experimental_loadQueryHandles` starts a loader's queries at once and returns a small serializable handle for each. Its entries come from `experimental_prefetchEntry`, which doesn't wait, `experimental_fetchEntry`, which waits for fresh data, and `experimental_ensureEntry`, which waits for any data, even if it is stale. It also returns the data of the fetch and ensure entries, so a loader can throw `notFound()`. `experimental_fromHandle` rebuilds the query's options from a handle. `experimental_waterfallHandle` builds a handle for an input known only during render, and the component that reads it starts the query. `experimental_InferQueryHandleData` gives the type of the data a reader gets from a factory or handle.
