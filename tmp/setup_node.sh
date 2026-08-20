#!/bin/bash
set -e
echo "Downloading Node.js v20..."
curl -fsSL https://nodejs.org/dist/v20.11.1/node-v20.11.1-darwin-arm64.tar.gz -o /tmp/node.tar.gz
echo "Extracting..."
mkdir -p /tmp/node-install
tar -xzf /tmp/node.tar.gz -C /tmp/node-install --strip-components=1
echo "Node version:"
/tmp/node-install/bin/node --version
echo "npm version:"
/tmp/node-install/bin/npm --version
echo "Done!"
