import { describe, expect, it } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/react'
import * as React from 'react'
import { QueryCache, useIsFetching, useQuery } from '..'
import {
  createQueryClient,
  queryKey,
  renderWithClient,
  setActTimeout,
  sleep,
} from './utils'

describe('useIsFetching', () => {
  // See https://github.com/tannerlinsley/react-query/issues/105
  it('should update as queries start and stop fetching', async () => {
    const queryCache = new QueryCache()
    const queryClient = createQueryClient({ queryCache })
    const key = queryKey()

    function IsFetching() {
      const isFetching = useIsFetching()
      return <div>isFetching: {isFetching}</div>
    }

    function Query() {
      const [ready, setReady] = React.useState(false)

      useQuery({
        queryKey: key,
        queryFn: async () => {
          await sleep(50)
          return 'test'
        },
        enabled: ready,
      })

      return <button onClick={() => setReady(true)}>setReady</button>
    }

    function Page() {
      return (
        <div>
          <IsFetching />
          <Query />
        </div>
      )
    }

    const { findByText, getByRole } = renderWithClient(queryClient, <Page />)

    await findByText('isFetching: 0')
    fireEvent.click(getByRole('button', { name: /setReady/i }))
    await findByText('isFetching: 1')
    await findByText('isFetching: 0')
  })

  it('should be able to filter', async () => {
    const queryClient = createQueryClient()
    const key1 = queryKey()
    const key2 = queryKey()

    const isFetchingArray: Array<number> = []

    function One() {
      useQuery({
        queryKey: key1,
        queryFn: async () => {
          await sleep(10)
          return 'test'
        },
      })
      return null
    }

    function Two() {
      useQuery({
        queryKey: key2,
        queryFn: async () => {
          await sleep(20)
          return 'test'
        },
      })
      return null
    }

    function Page() {
      const [started, setStarted] = React.useState(false)
      const isFetching = useIsFetching({ queryKey: key1 })

      isFetchingArray.push(isFetching)

      return (
        <div>
          <button onClick={() => setStarted(true)}>setStarted</button>
          <div>isFetching: {isFetching}</div>
          {started ? (
            <>
              <One />
              <Two />
            </>
          ) : null}
        </div>
      )
    }

    const { findByText, getByRole } = renderWithClient(queryClient, <Page />)

    await findByText('isFetching: 0')
    fireEvent.click(getByRole('button', { name: /setStarted/i }))
    await findByText('isFetching: 1')
    await findByText('isFetching: 0')
    // at no point should we have isFetching: 2
    expect(isFetchingArray).toEqual(expect.not.arrayContaining([2]))
  })

  it('should show the correct fetching state when mounted after a query', async () => {
    const queryClient = createQueryClient()
    const key = queryKey()

    function Page() {
      useQuery({
        queryKey: key,
        queryFn: async () => {
          await sleep(10)
          return 'test'
        },
      })

      const isFetching = useIsFetching()

      return (
        <div>
          <div>isFetching: {isFetching}</div>
        </div>
      )
    }

    const rendered = renderWithClient(queryClient, <Page />)

    await rendered.findByText('isFetching: 1')
    await rendered.findByText('isFetching: 0')
  })

  it('should use provided custom queryClient', async () => {
    const queryClient = createQueryClient()
    const key = queryKey()

    function Page() {
      useQuery(
        {
          queryKey: key,
          queryFn: async () => {
            await sleep(10)
            return 'test'
          },
        },
        queryClient,
      )

      const isFetching = useIsFetching({}, queryClient)

      return (
        <div>
          <div>isFetching: {isFetching}</div>
        </div>
      )
    }

    const rendered = render(<Page></Page>)

    await waitFor(() => rendered.getByText('isFetching: 1'))
  })
})
