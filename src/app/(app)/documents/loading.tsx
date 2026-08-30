import { Skeleton } from "@/components/ui/skeleton";

export default function DocumentsLoading() {
  return (
    <div className="h-full overflow-hidden">
      <div className="mx-auto max-w-5xl space-y-5 px-4 py-6 sm:px-6">
        <Skeleton className="h-10 w-full rounded-2xl" />
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[74px] rounded-xl" />
          ))}
        </div>
      </div>
    </div>
  );
}
