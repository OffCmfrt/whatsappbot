# WhatsApp Order Tracking Bot 🤖

A complete WhatsApp bot solution for order tracking with Shiprocket API integration and a powerful admin dashboard for broadcast messaging and customer management.

## ✨ Features

### Customer Features (WhatsApp Bot)
- 📦 **Real-time Order Tracking** - Check order status using Order ID or AWB number
- 📋 **Order History** - View all previous orders
- 🔔 **Automated Updates** - Get shipping updates via WhatsApp
- 💬 **24/7 Availability** - Instant responses anytime

### Admin Features (Dashboard)
- 📊 **Dashboard Overview** - Real-time statistics and metrics
- 👥 **Customer Management** - View and manage all customers
- 📢 **Broadcast Messaging** - Send messages to all or specific customer segments
- 🎁 **Offer Management** - Create and distribute promotional offers
- 💬 **Message History** - Track all conversations
- 📈 **Analytics** - Customer engagement and order insights

## 🆓 100% Free Stack

- **Meta WhatsApp Cloud API** - 1,000 free conversations/month
- **Supabase PostgreSQL** - Free tier database
- **Render.com** - Free hosting (750 hours/month)

## 🚀 Quick Start

### Prerequisites

1. **Meta WhatsApp Business Account**
   - Sign up at [Meta for Developers](https://developers.facebook.com/)
   - Create a WhatsApp Business App
   - Get your Access Token and Phone Number ID

2. **Supabase Account**
   - Sign up at [Supabase](https://supabase.com/)
   - Create a new project
   - Get your Project URL and Anon Key

3. **Shiprocket Account**
   - Sign up at [Shiprocket](https://www.shiprocket.in/)
   - Get your API credentials (email/password)

### Installation

1. **Clone or navigate to the project**
   ```bash
   cd whatsapp-bot
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**
   ```bash
   cp .env.example .env
   ```
   
   Edit `.env` and fill in your credentials:
   ```env
   # Meta WhatsApp Cloud API
   WHATSAPP_ACCESS_TOKEN=your_access_token
   WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
   WHATSAPP_BUSINESS_ACCOUNT_ID=your_business_account_id
   WHATSAPP_VERIFY_TOKEN=your_custom_verify_token

   # Shiprocket API
   SHIPROCKET_EMAIL=your_email@example.com
   SHIPROCKET_PASSWORD=your_password

   # Supabase
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_ANON_KEY=your_anon_key

   # Admin Dashboard
   ADMIN_USERNAME=admin
   ADMIN_PASSWORD=your_secure_password
   JWT_SECRET=your_random_secret_key
   ```

4. **Initialize database**
   ```bash
   npm start
   ```
   The database tables will be created automatically on first run.

5. **Migrate Excel data (optional)**
   ```bash
   npm run migrate path/to/your/data.xlsx
   ```

## 📊 Excel Migration

Your Excel file should have these columns (column names are flexible):

- **Phone** / **phone_number** / **Mobile** - Customer phone number
- **Customer Name** / **Name** - Customer name
- **Email** - Customer email (optional)
- **Order ID** - Order identifier
- **AWB** - Tracking number (optional)
- **Status** - Order status
- **Product** - Product name (optional)

Example:
```
Phone       | Customer Name | Email              | Order ID | Status
9876543210  | John Doe      | john@example.com   | 12345    | delivered
9123456789  | Jane Smith    | jane@example.com   | 12346    | shipped
```

## 🔧 WhatsApp Setup

### 1. Configure Webhook

In your Meta WhatsApp Business App settings:

1. Go to **Configuration** > **Webhooks**
2. Set **Callback URL**: `https://your-app.onrender.com/webhook`
3. Set **Verify Token**: (same as `WHATSAPP_VERIFY_TOKEN` in .env)
4. Subscribe to **messages** webhook field

### 2. Test the Bot

Send a message to your WhatsApp Business number:
- "Hi" - Get welcome message
- "12345" - Check order status (replace with actual order ID)
- "orders" - View order history
- "help" - Get help menu

## 👨‍💼 Admin Dashboard

Access the admin dashboard at: `http://localhost:3000/admin`

Default credentials (change in .env):
- **Username**: admin
- **Password**: (set in .env)

### Dashboard Features

1. **Overview** - View statistics and recent broadcasts
2. **Customers** - Manage customer database
3. **Broadcast** - Send messages to all or specific segments
4. **Offers** - Create and send promotional offers
5. **Messages** - View message history
6. **Analytics** - Customer engagement insights

## 🌐 Deployment (Render.com)

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin your-repo-url
git push -u origin main
```

### 2. Deploy on Render

1. Go to [Render Dashboard](https://dashboard.render.com/)
2. Click **New** > **Web Service**
3. Connect your GitHub repository
4. Render will auto-detect `render.yaml`
5. Add environment variables in Render dashboard
6. Click **Create Web Service**

### 3. Update WhatsApp Webhook

Update your webhook URL in Meta Developer Console to:
`https://your-app-name.onrender.com/webhook`

## 📱 Bot Commands

Customers can interact with the bot using:

- **Order ID** (e.g., "12345") - Check order status
- **AWB Number** - Track shipment
- **"orders"** or **"history"** - View order history
- **"help"** - Get help
- **"1"** - Check order status
- **"2"** - View order history
- **"3"** - Get help

## 🔒 Security

- Admin dashboard uses JWT authentication
- All API endpoints are protected
- Environment variables for sensitive data
- HTTPS enforced in production

## 🛠️ Development

Run in development mode with auto-reload:
```bash
npm run dev
```

## 📝 API Endpoints

### Public
- `GET /webhook` - WhatsApp webhook verification
- `POST /webhook` - Receive WhatsApp messages
- `GET /health` - Health check

### Admin (Protected)
- `POST /api/admin/login` - Admin login
- `GET /api/admin/stats` - Dashboard statistics
- `GET /api/admin/customers` - List customers
- `POST /api/admin/broadcast` - Send broadcast
- `POST /api/admin/offers` - Create offer
- `GET /api/admin/messages` - Message history
- `GET /api/admin/analytics` - Analytics data

## 🐛 Troubleshooting

### Bot not responding?
1. Check webhook is configured correctly
2. Verify `WHATSAPP_ACCESS_TOKEN` is valid
3. Check server logs for errors

### Database errors?
1. Verify Supabase credentials
2. Check if tables are created
3. Run `npm start` to initialize database

### Shiprocket not working?
1. Verify API credentials
2. Check if token is expired (auto-refreshes)
3. Ensure order IDs are correct

## 📚 Project Structure

```
whatsapp-bot/
├── src/
│   ├── database/       # Database connection and schema
│   ├── models/         # Data models (Customer, Order)
│   ├── services/       # Business logic (WhatsApp, Shiprocket, Broadcast)
│   ├── handlers/       # Message handlers
│   ├── routes/         # API routes
│   ├── middleware/     # Authentication middleware
│   └── utils/          # Utilities and validators
├── public/
│   └── dashboard/      # Admin dashboard frontend
├── scripts/
│   └── migrateExcel.js # Excel migration script
├── server.js           # Main server file
├── package.json        # Dependencies
└── render.yaml         # Deployment config
```

## 🤝 Support

For issues or questions:
1. Check the troubleshooting section
2. Review server logs
3. Verify all environment variables are set correctly

## 📄 License

ISC

---

**Built with ❤️ for seamless order tracking**
