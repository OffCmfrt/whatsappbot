#!/bin/bash
curl -fsSL https://nodejs.org/dist/v20.11.1/node-v20.11.1-darwin-arm64.tar.gz -o /tmp/node.tar.gz
mkdir -p /tmp/node-install
tar -xzf /tmp/node.tar.gz -C /tmp/node-install --strip-components=1
export PATH="/tmp/node-install/bin:$PATH"
node --version
npm --version
