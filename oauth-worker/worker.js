export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // STEP 1: redirect to GitHub OAuth
    if (url.pathname === "/auth") {

      const redirect = `https://github.com/login/oauth/authorize?client_id=${env.GITHUB_OAUTH_ID}&scope=repo`;

      return Response.redirect(redirect, 302);
    }

    // STEP 2: GitHub callback
    if (url.pathname === "/callback") {

      const code = url.searchParams.get("code");

      const tokenRequest = await fetch(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json"
          },
          body: JSON.stringify({
            client_id: env.GITHUB_OAUTH_ID,
            client_secret: env.GITHUB_OAUTH_SECRET,
            code: code
          })
        }
      );

      const data = await tokenRequest.json();

      if (!data.access_token) {
        return new Response("OAuth failed", { status: 400 });
      }

      return new Response(
        `<script>
          window.opener.postMessage(
            'authorization:github:success:${data.access_token}',
            '*'
          );
          window.close();
        </script>`,
        {
          headers: { "Content-Type": "text/html" }
        }
      );
    }

    return new Response("OAuth Worker Running");
  }
};