import { createClient } from "@supabase/supabase-js";

export default async (req) => {
  if (req.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const url = new URL(req.url);
    const token = url.searchParams.get("token");

    if (!token) {
      return Response.json(
        { error: "Share token missing" },
        { status: 400 }
      );
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: share, error: shareError } = await supabase
      .from("qubix_shares")
      .select("chat_id, user_id")
      .eq("share_token", token)
      .single();

    if (shareError || !share) {
      return Response.json(
        { error: "This share link is invalid or expired." },
        { status: 404 }
      );
    }

    const { data: chat, error: chatError } = await supabase
      .from("chats")
      .select("id, title, created_at")
      .eq("id", share.chat_id)
      .single();

    if (chatError || !chat) {
      return Response.json(
        { error: "Chat not found" },
        { status: 404 }
      );
    }

    const { data: messages, error: messagesError } = await supabase
      .from("messages")
      .select("role, content, created_at")
      .eq("chat_id", share.chat_id)
      .order("created_at", { ascending: true });

    if (messagesError) {
      throw messagesError;
    }

    return Response.json({
      chat: {
        title: chat.title,
        created_at: chat.created_at
      },
      messages: messages || []
    });

  } catch (error) {
    console.error("Share function error:", error);

    return Response.json(
      { error: "Unable to load shared chat." },
      { status: 500 }
    );
  }
};
