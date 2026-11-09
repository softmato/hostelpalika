#!/bin/sh
# Vercel "Ignored Build Step" (vercel.json ignoreCommand, which Vercel caps at 256 chars).
# Exit 0 skips the deploy, 1 builds; any other code fails the deploy. Pushes that only
# touch the Go server, CI, docs, the graph or design references never redeploy the web.
# If the last deployed commit is not in Vercel's shallow clone, git exits 128: build.
if git diff --quiet "${VERCEL_GIT_PREVIOUS_SHA:-HEAD^}" HEAD -- ../.. \
  ':(exclude)../../server' ':(exclude)../../.github' ':(exclude)../../docs' \
  ':(exclude)../../graphify-out' ':(exclude)../../ui_inspiration_folder' \
  ':(exclude)../../marketing' ':(exclude,glob)../../*.md'; then
  exit 0
fi
exit 1
