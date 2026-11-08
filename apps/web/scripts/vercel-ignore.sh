#!/bin/sh
# Vercel "Ignored Build Step" (vercel.json ignoreCommand, which Vercel caps at 256 chars).
# Exit 0 skips the deploy, 1 builds. Pushes that only touch the Go server, CI, docs,
# the graph or design references never redeploy the web. If the last deployed commit
# is not in Vercel's shallow clone, git fails and the deploy builds — the safe side.
git diff --quiet "${VERCEL_GIT_PREVIOUS_SHA:-HEAD^}" HEAD -- ../.. \
  ':(exclude)../../server' ':(exclude)../../.github' ':(exclude)../../docs' \
  ':(exclude)../../graphify-out' ':(exclude)../../ui_inspiration_folder' \
  ':(exclude)../../marketing' ':(exclude,glob)../../*.md'
