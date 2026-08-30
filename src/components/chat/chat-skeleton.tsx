import { Skeleton } from "@/components/ui/skeleton";

export function ChatSkeleton() {
  return (
    <div className="flex h-full min-h-0">
      <aside className="hidden w-72 shrink-0 border-r p-3 lg:block">
        <Skeleton className="h-8 w-full" />
        <div className="mt-4 space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
          <Skeleton className="h-5 w-36" />
        </header>
        <div className="flex min-h-0 flex-1 flex-col justify-end">
          <div className="mx-auto w-full max-w-3xl space-y-6 px-4 pb-6">
            <div className="flex justify-end">
              <Skeleton className="h-10 w-2/3 rounded-2xl" />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-4 w-11/12" />
              <Skeleton className="h-4 w-9/12" />
              <Skeleton className="h-4 w-10/12" />
            </div>
          </div>
          <footer className="px-3 pb-3 sm:px-6 sm:pb-4">
            <Skeleton className="mx-auto h-24 max-w-3xl rounded-2xl" />
          </footer>
        </div>
      </section>
    </div>
  );
}
