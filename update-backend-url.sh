#!/bin/bash

# Usage: ./update-backend-url.sh https://your-backend.railway.app

if [ -z "$1" ]; then
  echo "Usage: $0 <BACKEND_URL>"
  echo "Example: $0 https://sigmine-backend.up.railway.app"
  exit 1
fi

BACKEND_URL="$1"

echo "🔧 Updating all frontend files to use backend: $BACKEND_URL"

# Update config.js
cat > public/config.js << EOF
// API Configuration
window.SIGMINE_API_URL = '$BACKEND_URL';
EOF

echo "✅ Updated config.js"

# Update all HTML files to use the API URL variable (they already reference window.SIGMINE_API_URL)
# No need to change them - they're already configured!

echo "✅ All files updated!"
echo ""
echo "📦 Next steps:"
echo "  git add ."
echo "  git commit -m 'Update backend URL to Railway'"
echo "  git push"
echo ""
echo "🚀 Vercel will auto-deploy in ~30 seconds!"
