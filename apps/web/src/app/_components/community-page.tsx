"use client";

import { Globe, ImagePlus, Loader2, Play, Search, Send, Users, X } from "@/components/icons";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PublicShell } from "@/app/_components/shared";
import {
  COMMUNITY_ENDPOINT,
  CommunityPostCard,
  mediaUrl,
  type CommunityPost,
} from "@/app/_components/community-post-card";
import {
  CommunitySponsorRail,
  type CommunitySponsor,
  type PopularHostel,
} from "@/app/_components/community-sponsor-rail";
import { type LightboxItem } from "@/components/media-lightbox";
import { useMediaViewer } from "@/components/media-viewer";
import { useUploader } from "@/components/uploads";
import { browserApi } from "@/lib/browser-api";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast-store";

const PREFERENCES_ENDPOINT = "/api/v1/account/notification-preferences";
/** `COMMUNITY_POST_MUTE_KEY` in `modules/community/community-notify.ts`. */
const POST_MUTE_KEY = "COMMUNITY_POST";

/**
 * The web's copy of the app's Settings → "New community posts" switch. It
 * writes the same account preference, so muting on one mutes on both.
 */
function NewPostAlertsToggle() {
  const invalidate = useInvalidateResources();
  const prefs = usePortalResource<{ preference: { mutedCategories: string[] } }>(
    PREFERENCES_ENDPOINT,
    { errorMessage: "Could not load notification settings." },
  );
  const [saving, setSaving] = useState(false);

  if (!prefs.data) {
    return null;
  }

  const muted = prefs.data.preference.mutedCategories;
  const on = !muted.includes(POST_MUTE_KEY);

  const toggle = async () => {
    setSaving(true);

    try {
      await browserApi(PREFERENCES_ENDPOINT, {
        body: JSON.stringify({
          mutedCategories: on
            ? [...muted, POST_MUTE_KEY]
            : muted.filter((key) => key !== POST_MUTE_KEY),
        }),
        method: "PATCH",
      });
      invalidate(PREFERENCES_ENDPOINT);
      toast.success({ title: on ? "New post notifications muted" : "New post notifications on" });
    } catch (error) {
      toast.error({
        title: error instanceof Error ? error.message : "Could not save.",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-2.5">
      <span className="text-[13.5px] font-medium text-foreground">
        Notify me when someone posts
      </span>
      <button
        aria-checked={on}
        aria-label="Notify me when someone posts"
        className={cn(
          "relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-60",
          on ? "bg-primary" : "bg-muted",
        )}
        disabled={saving}
        onClick={() => void toggle()}
        role="switch"
        type="button"
      >
        <span
          className={cn(
            "absolute top-0.5 size-5 rounded-full bg-background shadow transition-all",
            on ? "left-[22px]" : "left-0.5",
          )}
        />
      </button>
    </div>
  );
}

type Space = {
  id: string;
  isMine: boolean;
  name: string;
  postCount: number;
};

type SpacesPayload = {
  spaces: Space[];
  viewer: {
    canPost: boolean;
    hostelId: string | null;
    hostelName: string | null;
    spaceType: "PUBLIC" | "HOSTEL" | null;
  };
};

type SidebarPayload = {
  popularHostels: PopularHostel[];
  sponsors: CommunitySponsor[];
  trendingTags: Array<{ count: number; tag: string }>;
};

type FeedPayload = {
  posts: CommunityPost[];
};

const SPACES_ENDPOINT = `${COMMUNITY_ENDPOINT}/spaces`;
const SIDEBAR_ENDPOINT = `${COMMUNITY_ENDPOINT}/sidebar`;

/** Long enough that a search is one request per phrase, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 300;

function RailHeading({ children }: { children: string }) {
  return (
    <p className="mb-2.5 text-[11px] font-bold uppercase tracking-[0.06em] text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * The platform-wide community.
 *
 * One route for everyone — signed out, public account, resident, staff — because
 * a community split across four portals is four quiet rooms. What differs by
 * account is only what you can *do*: reading needs nothing, writing needs an
 * account, and which space your post lands in is decided by whether you live in
 * a hostel (see `community.service.ts`).
 */
export function CommunityPageContent({ initialPostId }: { initialPostId?: string } = {}) {
  const [space, setSpace] = useState<string>("all");
  const [sort, setSort] = useState<"new" | "top">("new");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [body, setBody] = useState("");
  const [isPosting, setIsPosting] = useState(false);
  const [hostelOnly, setHostelOnly] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const media = useUploader({
    accessLevel: "PUBLIC",
    kind: "media",
    label: "Attachment",
    maxFiles: 6,
    optimizeImage: true,
  });
  const { open: openViewer } = useMediaViewer();
  // Same shape the feed itself opens — lets a draft attachment be previewed
  // full-screen, in the admin portal's own viewer, before it is ever posted.
  const mediaItems: LightboxItem[] = media.files.map((file) => ({
    kind: file.mimeType.startsWith("video/") ? "video" : "image",
    src: mediaUrl(file.assetId as string, "ORIGINAL"),
  }));

  // Debounced so typing a phrase is one request, not one per keystroke. The
  // input stays fully controlled by `search`; only `query` reaches the server.
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [search]);

  const feedUrl = initialPostId
    ? `${COMMUNITY_ENDPOINT}/${initialPostId}`
    : `${COMMUNITY_ENDPOINT}?space=${space}&sort=${sort}${
        query ? `&q=${encodeURIComponent(query)}` : ""
      }`;

  const invalidate = useInvalidateResources();
  const spaces = usePortalResource<SpacesPayload>(SPACES_ENDPOINT, {
    errorMessage: "Could not load community spaces.",
  });
  const sidebar = usePortalResource<SidebarPayload>(SIDEBAR_ENDPOINT, {
    errorMessage: "Could not load the sidebar.",
  });
  const feed = usePortalResource<FeedPayload | { post: CommunityPost }>(feedUrl, {
    errorMessage: "Could not load the community.",
  });

  const posts = useMemo(() => {
    if (!feed.data) {
      return [];
    }

    return "post" in feed.data ? [feed.data.post] : feed.data.posts;
  }, [feed.data]);

  const viewer = spaces.data?.viewer;
  const canPost = Boolean(viewer?.canPost);
  const postsToHostel = viewer?.spaceType === "HOSTEL";
  const hostelSpaces = (spaces.data?.spaces ?? []).filter((entry) => entry.id !== "public");

  const refresh = useCallback(() => {
    invalidate(feedUrl);
    invalidate(SPACES_ENDPOINT);
  }, [feedUrl, invalidate]);

  const publish = useCallback(async () => {
    const text = body.trim();

    if (!text) {
      return;
    }

    setIsPosting(true);

    try {
      await browserApi(COMMUNITY_ENDPOINT, {
        body: JSON.stringify({
          body: text,
          media: media.files
            .filter((file) => file.assetId)
            .map((file) => ({
              assetId: file.assetId as string,
              kind: file.mimeType.startsWith("video/") ? "VIDEO" : "IMAGE",
            })),
          visibility: postsToHostel && hostelOnly ? "HOSTEL_ONLY" : "PUBLIC",
        }),
        method: "POST",
      });
      setBody("");
      media.clear();
      toast.success({ title: "Posted" });
      refresh();
      invalidate(SIDEBAR_ENDPOINT);
    } catch (error) {
      toast.error({
        title: error instanceof Error ? error.message : "Could not post.",
      });
    } finally {
      setIsPosting(false);
    }
  }, [body, hostelOnly, invalidate, media, postsToHostel, refresh]);

  function renderSpaceButton(id: string, label: string, count?: number) {
    const isActive = space === id && !initialPostId;

    return (
      <button
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left text-[14.5px] transition",
          isActive
            ? "bg-brand-teal-soft font-bold text-brand-teal"
            : "font-medium text-foreground hover:bg-muted",
        )}
        key={id}
        onClick={() => setSpace(id)}
        type="button"
      >
        <span className="truncate">{label}</span>
        {typeof count === "number" ? (
          <span className="shrink-0 text-[13px] text-muted-foreground">{count}</span>
        ) : null}
      </button>
    );
  }

  return (
    <PublicShell active="community">
      {/* Both rails are wider than the mockup's, and the page carries more
          horizontal padding as the viewport grows — the rails move in from the
          edges and the centre column narrows with them, which is what keeps a
          long post readable instead of running the full width of a monitor. */}
      <div className="mx-auto grid max-w-[1580px] gap-6 px-4 pb-24 pt-8 md:px-6 lg:grid-cols-[minmax(200px,240px)_minmax(0,1fr)_minmax(260px,300px)] lg:px-8 xl:grid-cols-[minmax(240px,280px)_minmax(0,1fr)_minmax(300px,340px)] xl:gap-8 xl:px-12 2xl:px-20">
        {/* Pinned as soon as it reaches the top — the header is fixed and 4rem
            tall, so that is where "the top" actually is. */}
        <aside className="hidden self-start lg:sticky lg:top-16 lg:block lg:pt-4">
          <p className="mb-4 font-heading text-[22px] font-extrabold text-foreground">
            Community
          </p>

          <RailHeading>Spaces</RailHeading>
          <div className="mb-6 flex flex-col gap-0.5">
            {renderSpaceButton("all", "Everything")}
            {renderSpaceButton("public", "Public")}
            {viewer?.hostelId
              ? renderSpaceButton("mine", viewer.hostelName ?? "My hostel")
              : null}
          </div>

          {hostelSpaces.length > 0 ? (
            <>
              <RailHeading>Hostels</RailHeading>
              <div className="mb-6 flex flex-col gap-0.5">
                {hostelSpaces.map((entry) =>
                  renderSpaceButton(entry.id, entry.name, entry.postCount),
                )}
              </div>
            </>
          ) : null}

          {(sidebar.data?.trendingTags ?? []).length > 0 ? (
            <>
              <RailHeading>Trending tags</RailHeading>
              <div className="mb-6 flex flex-wrap gap-1.5">
                {sidebar.data?.trendingTags.map(({ tag }) => (
                  <button
                    className={cn(
                      "rounded-full px-2.5 py-1 text-[12.5px] transition",
                      search === tag
                        ? "bg-brand-teal-soft font-semibold text-brand-teal"
                        : "bg-muted text-muted-foreground hover:text-foreground",
                    )}
                    key={tag}
                    // A tag is a saved search, not a separate filter — one
                    // input owns "what am I looking at" either way.
                    onClick={() => setSearch((current) => (current === tag ? "" : tag))}
                    type="button"
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </>
          ) : null}

          <div className="rounded-xl border border-border p-4">
            <RailHeading>Guidelines</RailHeading>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              Be respectful. No spam. Keep hostel reviews honest and specific.
            </p>
          </div>
        </aside>

        <div className="min-w-0">
          {initialPostId ? (
            <Link
              className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-brand-teal hover:underline"
              href="/community"
            >
              ← Back to Community
            </Link>
          ) : (
            <>
              {/* Pinned like the rails, so search and sort stay reachable
                  however far down the feed you are. The negative inline margin
                  plus matching padding lets the blurred backdrop cover the full
                  column width while the row itself stays aligned with the posts. */}
              <div className="sticky top-16 z-20 -mx-1 mb-5 flex items-center gap-3 bg-background/90 px-1 py-3 backdrop-blur">
                <div className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl bg-muted px-4 py-3">
                  <Search className="size-4 shrink-0 text-muted-foreground" />
                  <input
                    className="min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search anything…"
                    type="text"
                    value={search}
                  />
                  {search ? (
                    <button
                      aria-label="Clear search"
                      className="shrink-0 text-muted-foreground transition hover:text-foreground"
                      onClick={() => setSearch("")}
                      type="button"
                    >
                      <X className="size-4" />
                    </button>
                  ) : null}
                </div>
                <div className="flex shrink-0 gap-0.5 rounded-[9px] bg-muted p-[3px]">
                  {(["new", "top"] as const).map((option) => (
                    <button
                      className={cn(
                        "rounded-[7px] px-4 py-2 text-[13.5px] font-bold capitalize transition",
                        sort === option
                          ? "bg-background text-brand-teal shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      key={option}
                      onClick={() => setSort(option)}
                      type="button"
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </div>

              {canPost ? <NewPostAlertsToggle /> : null}

              {canPost ? (
                <section className="mb-6 rounded-2xl border border-border bg-surface p-5">
                  <textarea
                    className="min-h-[44px] w-full resize-y bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
                    maxLength={4000}
                    onChange={(event) => setBody(event.target.value)}
                    placeholder="Share something with the community…"
                    value={body}
                  />

                  {media.files.length > 0 ? (
                    <div
                      className={cn(
                        "mb-2 grid gap-1.5",
                        media.files.length === 1 ? "grid-cols-1" : "grid-cols-2",
                      )}
                    >
                      {media.files.map((file, index) => {
                        const isVideo = file.mimeType.startsWith("video/");
                        const src = mediaUrl(
                          file.assetId as string,
                          media.files.length === 1 ? "LARGE" : "MEDIUM",
                        );

                        return (
                          <div
                            className="relative overflow-hidden rounded-lg bg-muted"
                            key={file.id}
                          >
                            <button
                              className="block w-full cursor-zoom-in"
                              onClick={() => openViewer(mediaItems, index)}
                              type="button"
                            >
                              {isVideo ? (
                                <>
                                  <video
                                    className={cn(
                                      "w-full object-cover",
                                      media.files.length === 1 ? "max-h-72" : "h-36",
                                    )}
                                    muted
                                    src={src}
                                  />
                                  <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                                    <span className="flex size-10 items-center justify-center rounded-full bg-black/50">
                                      <Play className="size-4 fill-white text-white" />
                                    </span>
                                  </span>
                                </>
                              ) : (
                                // eslint-disable-next-line @next/next/no-img-element -- preview of a freshly uploaded asset.
                                <img
                                  alt={file.name}
                                  className={cn(
                                    "w-full object-cover",
                                    media.files.length === 1 ? "max-h-72" : "h-36",
                                  )}
                                  src={src}
                                />
                              )}
                            </button>
                            <button
                              aria-label={`Remove ${file.name}`}
                              className="absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-full bg-black/60 text-white transition hover:bg-black/80"
                              onClick={() => media.remove(file.id)}
                              type="button"
                            >
                              <X className="size-3.5" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}

                  <div className="mt-2.5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
                    <input
                      accept={media.accept}
                      className="hidden"
                      multiple
                      onChange={media.handleInputChange}
                      ref={fileInputRef}
                      type="file"
                    />
                    <button
                      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground"
                      onClick={() => fileInputRef.current?.click()}
                      title={media.hint}
                      type="button"
                    >
                      <ImagePlus className="size-4" />
                      Photo / video
                    </button>

                    <div className="flex flex-wrap items-center gap-3.5">
                      {/* Only a hostel post has an audience to narrow. A public
                          account has no smaller room to post into. */}
                      {postsToHostel ? (
                        <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                          <input
                            checked={hostelOnly}
                            onChange={(event) => setHostelOnly(event.target.checked)}
                            type="checkbox"
                          />
                          Members only
                        </label>
                      ) : null}

                      <span className="inline-flex items-center gap-1.5 text-[13.5px] text-muted-foreground">
                        {postsToHostel ? (
                          <>
                            <Users className="size-3.5" />
                            Posting to {viewer?.hostelName}
                          </>
                        ) : (
                          <>
                            <Globe className="size-3.5" />
                            Posting to Public
                          </>
                        )}
                      </span>

                      <button
                        className="inline-flex h-9 items-center gap-1.5 rounded-[9px] bg-brand-teal px-4 text-sm font-bold text-white transition hover:brightness-110 disabled:opacity-50"
                        disabled={isPosting || media.isUploading || !body.trim()}
                        onClick={() => void publish()}
                        type="button"
                      >
                        {isPosting ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Send className="size-4" />
                        )}
                        Post
                      </button>
                    </div>
                  </div>
                </section>
              ) : spaces.state === "ready" ? (
                <p className="mb-6 rounded-2xl border border-dashed border-border p-4 text-sm text-muted-foreground">
                  <Link className="font-semibold text-brand-teal" href="/login">
                    Sign in
                  </Link>{" "}
                  to post, comment and react. Reading is open to everyone.
                </p>
              ) : null}
            </>
          )}

          {feed.state === "loading" ? (
            <div className="space-y-4">
              {[0, 1, 2].map((row) => (
                <div className="h-40 animate-pulse rounded-2xl bg-muted" key={row} />
              ))}
            </div>
          ) : null}

          {feed.message ? (
            <p className="rounded-2xl border border-border p-4 text-sm text-muted-foreground">
              {feed.message}
            </p>
          ) : null}

          {feed.state === "ready" && posts.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              {query
                ? `Nothing matches “${query}”.`
                : "Nothing here yet. Be the first to post."}
            </p>
          ) : null}

          {posts.map((post) => (
            <CommunityPostCard
              canInteract={canPost}
              key={post.id}
              onChanged={refresh}
              post={post}
              standalone={Boolean(initialPostId)}
            />
          ))}
        </div>

        <CommunitySponsorRail
          popularHostels={sidebar.data?.popularHostels ?? []}
          sponsors={sidebar.data?.sponsors ?? []}
        />
      </div>
    </PublicShell>
  );
}
