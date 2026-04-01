# Website Deployment Guide

This guide covers deploying the Mako marketing website to Vercel.

## Prerequisites

- GitHub account
- Vercel account (sign up at [vercel.com](https://vercel.com))
- Git repository for your project

## Deployment Steps

### Option 1: Deploy via Vercel Dashboard (Recommended)

1. **Push your code to GitHub**

   ```bash
   git add .
   git commit -m "Add website"
   git push origin main
   ```

2. **Import to Vercel**

   - Go to [vercel.com/new](https://vercel.com/new)
   - Click "Import Project"
   - Select your GitHub repository
   - Vercel will auto-detect Next.js

3. **Configure Project**

   - **Root Directory**: Set to `website`
   - **Framework Preset**: Next.js (auto-detected)
   - **Build Command**: `npm run build` (default)
   - **Output Directory**: `.next` (default)
   - **Install Command**: `npm install` (default)

4. **Deploy**
   - Click "Deploy"
   - Wait for the build to complete
   - Your site will be live at `https://your-project.vercel.app`

### Option 2: Deploy via Vercel CLI

1. **Install Vercel CLI**

   ```bash
   npm i -g vercel
   ```

2. **Login to Vercel**

   ```bash
   vercel login
   ```

3. **Deploy from website directory**

   ```bash
   cd website
   vercel
   ```

4. **Follow the prompts**

   - Set up and deploy? Yes
   - Which scope? Select your account
   - Link to existing project? No
   - What's your project's name? mako-website
   - In which directory is your code located? ./
   - Want to override settings? No

5. **Deploy to production**
   ```bash
   vercel --prod
   ```

## Environment Variables

The website doesn't require environment variables by default. However, you may want to add:

### Production App URL

Update the app links in `app/page.tsx` to point to your production app:

```typescript
// Replace localhost URLs with your production app URL
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://app.mako.ai";
```

Then set in Vercel:

- **Key**: `NEXT_PUBLIC_APP_URL`
- **Value**: `https://app.mako.ai`

## Custom Domain

### Add Custom Domain in Vercel

1. Go to your project settings in Vercel
2. Navigate to "Domains"
3. Add your domain (e.g., `mako.ai`)
4. Follow DNS configuration instructions

### DNS Configuration

Add these records to your DNS provider:

**For apex domain (mako.ai):**

```
Type: A
Name: @
Value: 76.76.21.21
```

**For www subdomain:**

```
Type: CNAME
Name: www
Value: cname.vercel-dns.com
```

## Automatic Deployments

Vercel automatically deploys:

- **Production**: Pushes to `main` branch → `https://yoursite.com`
- **Preview**: Pull requests → `https://pr-123-yourproject.vercel.app`

## Build Configuration

The website uses these settings (in `vercel.json`):

```json
{
  "buildCommand": "npm run build",
  "outputDirectory": ".next",
  "devCommand": "npm run dev",
  "installCommand": "npm install",
  "framework": "nextjs"
}
```

## Performance Optimizations

Vercel automatically provides:

- ✅ Edge Network CDN
- ✅ Automatic HTTPS
- ✅ Image Optimization
- ✅ Compression (Brotli/Gzip)
- ✅ Smart Caching

## Monitoring

### Analytics

Enable Vercel Analytics:

1. Go to project settings
2. Navigate to "Analytics"
3. Enable Web Analytics

### Speed Insights

Enable Speed Insights:

1. Go to project settings
2. Navigate to "Speed Insights"
3. Enable Real Experience Score

## Troubleshooting

### Build Fails

Check build logs in Vercel dashboard. Common issues:

- Missing dependencies: Run `npm install` locally first
- TypeScript errors: Run `npm run build` locally to test
- Node version mismatch: Specify Node version in `package.json`:
  ```json
  "engines": {
    "node": ">=18.0.0"
  }
  ```

### 404 Errors

- Ensure `vercel.json` is in the website directory
- Check that routes are defined in `app/` directory
- Verify build completed successfully

### Slow Build Times

- Enable caching in Vercel settings
- Reduce dependencies if possible
- Consider upgrading to Vercel Pro for faster builds

## Local Preview of Production Build

Test production build locally:

```bash
cd website
npm run build
npm start
```

Visit `http://localhost:3000` to see production build.

## Rollback

If a deployment has issues:

1. Go to Vercel dashboard
2. Navigate to "Deployments"
3. Find a previous working deployment
4. Click "⋯" → "Promote to Production"

## Resources

- [Vercel Documentation](https://vercel.com/docs)
- [Next.js Deployment](https://nextjs.org/docs/deployment)
- [Vercel CLI Reference](https://vercel.com/docs/cli)
