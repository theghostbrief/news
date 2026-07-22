# Facebook Page API — Quick Publishing Setup

> Quick reference for setting up publishing to a Facebook **Page** via the Graph API.
> Full research history (including profile-automation attempts) — see `facebook-setup.md`.

---

## 1. Create a Meta app

1. Go to [developers.facebook.com](https://developers.facebook.com/) → **Create App**
2. Use case: **Content management** → "Manage everything on your Page"
3. Enter an app name and email

**IMPORTANT about Business Portfolio:**
- If you link the app to a Business Portfolio at creation, Graph API Explorer will only show **pages that belong to that portfolio**
- If you need personal pages (not part of a portfolio) — choose **"I don't want to connect a business portfolio yet"**
- This can be changed later, but it's simpler to choose correctly up front

---

## 2. Getting a Page Access Token

### Method A: Graph API Explorer (simple)

1. Go to **Tools → Graph API Explorer**
2. Select your app
3. Click **"Get Token"** → **"Get Page Access Token"**
4. Grant permissions: `pages_manage_posts`, `pages_read_engagement`, `pages_show_list`
5. Select the page you want
6. Explorer will show the Page Access Token

### Method B: Direct OAuth URL (if Explorer doesn't show the page you need)

Sometimes Graph API Explorer won't show the page you need (especially if it isn't in a Business Portfolio). In that case, use a direct OAuth flow:

```
https://www.facebook.com/v23.0/dialog/oauth?client_id=APP_ID&redirect_uri=https://localhost/&scope=pages_manage_posts,pages_read_engagement,pages_show_list&response_type=token
```

Replace `APP_ID` with your app's ID. After authorizing, the browser redirects to `https://localhost/#access_token=...` — copy the User Token from the URL.

### Getting a Page Token from the User Token

A User Token is not a Page Token. You need to exchange it:

```bash
curl "https://graph.facebook.com/v23.0/me/accounts?access_token=USER_TOKEN"
```

The response contains a list of pages, each with an `access_token` and `id`:

```json
{
  "data": [
    {
      "access_token": "PAGE_ACCESS_TOKEN_HERE",
      "id": "YOUR_FACEBOOK_PAGE_ID",
      "name": "The Ghost Brief"
    }
  ]
}
```

### Page ID

Record your page's numeric ID here once you have it (from the response above):

| Page | Page ID |
|------|---------|
| The Ghost Brief (facebook.com/theghostbrief) | *(fill in after Method A/B above)* |

---

## 3. Publishing via the API

```bash
curl -X POST "https://graph.facebook.com/v19.0/{PAGE_ID}/feed" \
  -d "message=Post text" \
  -d "access_token=PAGE_ACCESS_TOKEN"
```

Response:

```json
{
  "id": "YOUR_FACEBOOK_PAGE_ID_123456789"
}
```

---

## 4. Token lifetime

| Type | Lifetime |
|------|----------|
| Short-lived token | ~1-2 hours |
| Long-lived token | ~60 days |

### Exchanging short-lived → long-lived

```bash
curl "https://graph.facebook.com/v23.0/oauth/access_token?\
grant_type=fb_exchange_token&\
client_id=APP_ID&\
client_secret=APP_SECRET&\
fb_exchange_token=SHORT_LIVED_TOKEN"
```

**IMPORTANT:** A long-lived token lasts ~60 days. It must be refreshed before it expires, or publishing will stop working.

---

## 5. Environment variables

In the `.env` file (or on the VPS):

```env
FACEBOOK_PAGE_ID=YOUR_FACEBOOK_PAGE_ID
FACEBOOK_PAGE_ACCESS_TOKEN=EAAxxxxxx...
```

- `FACEBOOK_PAGE_ID` — the page's ID (not a personal profile!)
- `FACEBOOK_PAGE_ACCESS_TOKEN` — specifically a Page Access Token, **not** a User Token

---

## 6. Verification

### Confirm the token is valid and belongs to the page

```bash
curl "https://graph.facebook.com/v23.0/me?fields=id,name&access_token=TOKEN"
```

Should return the **page's** name (e.g. "The Ghost Brief"), not a personal user's name.

### Confirm access to the page's feed

```bash
curl "https://graph.facebook.com/v23.0/PAGE_ID/feed?access_token=TOKEN"
```

Should return a list of the page's recent posts.
