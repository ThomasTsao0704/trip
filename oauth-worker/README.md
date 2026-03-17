# Decap CMS GitHub OAuth Worker

OAuth proxy for Decap CMS using GitHub backend.

## Install

npm install -g wrangler

## Login to Cloudflare

wrangler login

## Deploy

wrangler deploy

## Set Secrets

wrangler secret put GITHUB_OAUTH_ID
wrangler secret put GITHUB_OAUTH_SECRET

## GitHub OAuth App

Callback URL must be:

https://YOUR-WORKER.workers.dev/callback

## Decap CMS config

backend:
  name: github
  repo: USER/REPO
  base_url: https://YOUR-WORKER.workers.dev
  auth_endpoint: auth