type TaggedResult<T, R> = {
  index: number;
  result: IteratorResult<T, R>;
};

/**
 * Merge independent async generators while retaining each generator's final
 * return value in the same order as the input streams.
 */
export async function* mergeAsyncGenerators<T, R>(
  streams: readonly AsyncGenerator<T, R>[],
): AsyncGenerator<T, R[]> {
  const finalValues: R[] = new Array<R>(streams.length);
  const completed = new Set<number>();
  const pending = new Map<number, Promise<TaggedResult<T, R>>>();

  const schedule = (index: number): void => {
    const stream = streams[index];
    if (stream === undefined) throw new Error(`Missing async generator at index ${index}.`);
    pending.set(index, stream.next().then((result) => ({ index, result })));
  };

  for (let index = 0; index < streams.length; index += 1) schedule(index);

  try {
    while (pending.size > 0) {
      const settled = await Promise.race([...pending.values()]);
      pending.delete(settled.index);
      if (settled.result.done) {
        finalValues[settled.index] = settled.result.value;
        completed.add(settled.index);
        continue;
      }
      schedule(settled.index);
      yield settled.result.value;
    }
    return finalValues;
  } finally {
    const cleanup = streams.flatMap((stream, index) => (
      completed.has(index) ? [] : [stream.return(undefined as R)]
    ));
    await Promise.allSettled(cleanup);
  }
}
