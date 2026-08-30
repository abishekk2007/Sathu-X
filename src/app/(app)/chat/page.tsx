import { Suspense } from "react";
import { ChatSkeleton } from "@/components/chat/chat-skeleton";
import { ChatWorkspace } from "@/components/chat/chat-workspace";

export const metadata = {
  title: "Chat",
};

export default function ChatPage() {
  return (
    <Suspense fallback={<ChatSkeleton />}>
      <ChatWorkspace />
    </Suspense>
  );
}
