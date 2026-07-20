require('dotenv').config();
const XLSX = require('xlsx');
const path = require('path');
const Customer = require('../src/models/Customer');
const Order = require('../src/models/Order');
const { testConnection } = require('../src/database/db');

async function migrateExcelData() {
    console.log('📊 Excel to Supabase Migration Tool');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    try {
        // Test database connection
        console.log('🔄 Testing database connection...');
        const connected = await testConnection();

        if (!connected) {
            console.error('❌ Database connection failed. Please check your credentials.');
            process.exit(1);
        }

        // Get Excel file path from command line argument
        const excelFilePath = process.argv[2];

        if (!excelFilePath) {
            console.error('❌ Please provide Excel file path as argument');
            console.log('Usage: npm run migrate path/to/your/file.xlsx');
            process.exit(1);
        }

        // Check if file exists
        const fullPath = path.resolve(excelFilePath);
        console.log(`📂 Reading file: ${fullPath}\n`);

        // Read Excel file
        const workbook = XLSX.readFile(fullPath);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(worksheet);

        console.log(`✅ Found ${data.length} rows in Excel file\n`);

        if (data.length === 0) {
            console.log('⚠️  No data found in Excel file');
            process.exit(0);
        }

        // Display first row to show column structure
        console.log('📋 Excel columns detected:');
        console.log(Object.keys(data[0]).join(', '));
        console.log('\n');

        // Migration statistics
        let stats = {
            customersCreated: 0,
            customersSkipped: 0,
            ordersCreated: 0,
            ordersSkipped: 0,
            errors: []
        };

        // Process each row
        console.log('🔄 Starting migration...\n');

        for (let i = 0; i < data.length; i++) {
            const row = data[i];

            try {
                // Extract customer data (adjust column names based on your Excel)
                const customerPhone = extractPhone(row);
                const customerName = row['Customer Name'] || row['Name'] || row['customer_name'] || null;
                const customerEmail = row['Email'] || row['email'] || null;

                if (!customerPhone) {
                    stats.errors.push(`Row ${i + 1}: No phone number found`);
                    continue;
                }

                // Create or get customer
                let customer = await Customer.findByPhone(customerPhone);

                if (!customer) {
                    customer = await Customer.create({
                        phone: customerPhone,
                        name: customerName,
                        email: customerEmail
                    });

                    if (customer) {
                        stats.customersCreated++;
                        console.log(`✅ Created customer: ${customerPhone}`);
                    } else {
                        stats.customersSkipped++;
                        stats.errors.push(`Row ${i + 1}: Failed to create customer ${customerPhone}`);
                    }
                } else {
                    stats.customersSkipped++;
                }

                // Extract order data (if exists in Excel)
                const orderId = row['Order ID'] || row['order_id'] || row['OrderID'] || null;

                if (orderId) {
                    const existingOrder = await Order.findByOrderId(orderId);

                    if (!existingOrder) {
                        const order = await Order.create({
                            order_id: orderId,
                            customer_phone: customerPhone,
                            shiprocket_order_id: row['Shiprocket Order ID'] || row['shiprocket_order_id'] || null,
                            awb: row['AWB'] || row['awb'] || null,
                            status: row['Status'] || row['status'] || 'pending',
                            courier_name: row['Courier'] || row['courier_name'] || null,
                            product_name: row['Product'] || row['product_name'] || null,
                            order_date: row['Order Date'] || row['order_date'] || new Date(),
                            expected_delivery: row['Expected Delivery'] || row['expected_delivery'] || null
                        });

                        if (order) {
                            stats.ordersCreated++;
                            console.log(`  📦 Created order: ${orderId}`);
                        } else {
                            stats.ordersSkipped++;
                        }
                    } else {
                        stats.ordersSkipped++;
                    }
                }

            } catch (error) {
                stats.errors.push(`Row ${i + 1}: ${error.message}`);
                console.error(`❌ Error processing row ${i + 1}:`, error.message);
            }

            // Progress indicator
            if ((i + 1) % 10 === 0) {
                console.log(`\n📊 Progress: ${i + 1}/${data.length} rows processed\n`);
            }
        }

        // Print summary
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📊 Migration Summary');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        console.log(`✅ Customers created: ${stats.customersCreated}`);
        console.log(`⏭️  Customers skipped: ${stats.customersSkipped}`);
        console.log(`✅ Orders created: ${stats.ordersCreated}`);
        console.log(`⏭️  Orders skipped: ${stats.ordersSkipped}`);
        console.log(`❌ Errors: ${stats.errors.length}\n`);

        if (stats.errors.length > 0) {
            console.log('⚠️  Errors encountered:');
            stats.errors.slice(0, 10).forEach(err => console.log(`  - ${err}`));
            if (stats.errors.length > 10) {
                console.log(`  ... and ${stats.errors.length - 10} more errors`);
            }
        }

        console.log('\n✅ Migration completed!\n');

    } catch (error) {
        console.error('\n❌ Migration failed:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

// Helper function to extract phone number from various column names
function extractPhone(row) {
    const phoneFields = [
        'Phone', 'phone', 'Phone Number', 'phone_number',
        'Mobile', 'mobile', 'Customer Phone', 'customer_phone',
        'Contact', 'contact'
    ];

    for (const field of phoneFields) {
        if (row[field]) {
            // Clean phone number
            let phone = String(row[field]).replace(/\D/g, '');

            // Add country code if needed (assuming India)
            if (phone.length === 10) {
                phone = '91' + phone;
            }

            return phone;
        }
    }

    return null;
}

// Run migration
migrateExcelData();
