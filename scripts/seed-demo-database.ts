/**
 * Demo Database Seed Script
 *
 * Populates the shared demo MongoDB database with sample e-commerce data.
 * This data is read-only and shared across all workspaces using the demo feature.
 *
 * Usage:
 *   npx ts-node scripts/seed-demo-database.ts
 *
 * Environment variables:
 *   DEMO_DATABASE_CONNECTION_STRING - MongoDB connection string for demo database
 *   DEMO_DATABASE_NAME - Name of the demo database (default: mako_demo)
 */

import { MongoClient, ObjectId } from "mongodb";

// Configuration
const DEMO_CONNECTION_STRING =
  process.env.DEMO_DATABASE_CONNECTION_STRING || "mongodb://localhost:27017";
const DEMO_DATABASE_NAME = process.env.DEMO_DATABASE_NAME || "mako_demo";

// Sample data generators
const PRODUCT_CATEGORIES = [
  "Electronics",
  "Clothing",
  "Home & Garden",
  "Sports",
  "Books",
  "Toys",
  "Health & Beauty",
  "Food & Beverages",
];

const COUNTRIES = [
  "United States",
  "United Kingdom",
  "Canada",
  "Germany",
  "France",
  "Australia",
  "Japan",
  "Brazil",
];

const ORDER_STATUSES = ["pending", "processing", "shipped", "delivered", "cancelled"];

const FIRST_NAMES = [
  "James",
  "Mary",
  "John",
  "Patricia",
  "Robert",
  "Jennifer",
  "Michael",
  "Linda",
  "William",
  "Elizabeth",
  "David",
  "Barbara",
  "Richard",
  "Susan",
  "Joseph",
  "Jessica",
];

const LAST_NAMES = [
  "Smith",
  "Johnson",
  "Williams",
  "Brown",
  "Jones",
  "Garcia",
  "Miller",
  "Davis",
  "Rodriguez",
  "Martinez",
  "Hernandez",
  "Lopez",
  "Gonzalez",
  "Wilson",
  "Anderson",
  "Thomas",
];

const PRODUCT_ADJECTIVES = [
  "Premium",
  "Deluxe",
  "Professional",
  "Compact",
  "Portable",
  "Advanced",
  "Classic",
  "Modern",
];

const PRODUCT_NOUNS: Record<string, string[]> = {
  Electronics: ["Laptop", "Headphones", "Smartphone", "Tablet", "Camera", "Speaker"],
  Clothing: ["T-Shirt", "Jeans", "Jacket", "Dress", "Sweater", "Sneakers"],
  "Home & Garden": ["Lamp", "Chair", "Planter", "Rug", "Vase", "Mirror"],
  Sports: ["Yoga Mat", "Dumbbells", "Tennis Racket", "Football", "Basketball", "Bicycle"],
  Books: ["Novel", "Cookbook", "Biography", "Textbook", "Guide", "Journal"],
  Toys: ["Building Blocks", "Board Game", "Puzzle", "Action Figure", "Doll", "Car Set"],
  "Health & Beauty": ["Face Cream", "Shampoo", "Perfume", "Vitamin Set", "Makeup Kit", "Razor"],
  "Food & Beverages": ["Coffee Beans", "Tea Set", "Chocolate Box", "Wine", "Olive Oil", "Spice Set"],
};

// Helper functions
function randomElement<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomDate(start: Date, end: Date): Date {
  return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
}

function generateEmail(firstName: string, lastName: string): string {
  const domain = randomElement(["gmail.com", "yahoo.com", "outlook.com", "example.com"]);
  return `${firstName.toLowerCase()}.${lastName.toLowerCase()}${randomInt(1, 999)}@${domain}`;
}

// Data generators
function generateProducts(count: number) {
  const products = [];
  for (let i = 0; i < count; i++) {
    const category = randomElement(PRODUCT_CATEGORIES);
    const adjective = randomElement(PRODUCT_ADJECTIVES);
    const noun = randomElement(PRODUCT_NOUNS[category]);
    products.push({
      _id: new ObjectId(),
      name: `${adjective} ${noun}`,
      category,
      price: parseFloat((Math.random() * 500 + 10).toFixed(2)),
      inventory: randomInt(0, 1000),
      rating: parseFloat((Math.random() * 2 + 3).toFixed(1)), // 3.0 - 5.0
      createdAt: randomDate(new Date("2023-01-01"), new Date("2024-06-01")),
      description: `High-quality ${noun.toLowerCase()} perfect for any ${category.toLowerCase()} enthusiast.`,
      sku: `SKU-${category.substring(0, 3).toUpperCase()}-${String(i + 1).padStart(5, "0")}`,
      tags: [category.toLowerCase(), noun.toLowerCase(), adjective.toLowerCase()],
    });
  }
  return products;
}

function generateCustomers(count: number) {
  const customers = [];
  for (let i = 0; i < count; i++) {
    const firstName = randomElement(FIRST_NAMES);
    const lastName = randomElement(LAST_NAMES);
    customers.push({
      _id: new ObjectId(),
      email: generateEmail(firstName, lastName),
      name: `${firstName} ${lastName}`,
      country: randomElement(COUNTRIES),
      signupDate: randomDate(new Date("2022-01-01"), new Date("2024-06-01")),
      totalOrders: 0, // Will be updated after orders are generated
      totalSpent: 0, // Will be updated after orders are generated
      isVerified: Math.random() > 0.2,
      preferences: {
        newsletter: Math.random() > 0.5,
        notifications: Math.random() > 0.3,
      },
    });
  }
  return customers;
}

function generateOrders(products: any[], customers: any[], count: number) {
  const orders = [];
  const customerOrderCounts: Record<string, { count: number; spent: number }> = {};

  for (let i = 0; i < count; i++) {
    const customer = randomElement(customers);
    const customerId = customer._id.toString();
    const numItems = randomInt(1, 5);
    const items = [];
    let total = 0;

    for (let j = 0; j < numItems; j++) {
      const product = randomElement(products);
      const quantity = randomInt(1, 3);
      const itemTotal = product.price * quantity;
      total += itemTotal;
      items.push({
        productId: product._id,
        productName: product.name,
        quantity,
        price: product.price,
        subtotal: parseFloat(itemTotal.toFixed(2)),
      });
    }

    total = parseFloat(total.toFixed(2));

    // Track customer order counts
    if (!customerOrderCounts[customerId]) {
      customerOrderCounts[customerId] = { count: 0, spent: 0 };
    }
    customerOrderCounts[customerId].count++;
    customerOrderCounts[customerId].spent += total;

    orders.push({
      _id: new ObjectId(),
      customerId: customer._id,
      customerEmail: customer.email,
      items,
      total,
      status: randomElement(ORDER_STATUSES),
      createdAt: randomDate(new Date("2023-06-01"), new Date("2024-06-01")),
      shippingAddress: {
        country: customer.country,
        city: `City ${randomInt(1, 100)}`,
        zipCode: String(randomInt(10000, 99999)),
      },
      paymentMethod: randomElement(["credit_card", "paypal", "bank_transfer"]),
    });
  }

  // Update customer totalOrders and totalSpent
  for (const customer of customers) {
    const stats = customerOrderCounts[customer._id.toString()];
    if (stats) {
      customer.totalOrders = stats.count;
      customer.totalSpent = parseFloat(stats.spent.toFixed(2));
    }
  }

  return orders;
}

function generateReviews(products: any[], customers: any[], count: number) {
  const reviews = [];
  const reviewPhrases = {
    positive: [
      "Excellent product, highly recommend!",
      "Great quality for the price.",
      "Exactly what I was looking for.",
      "Fast shipping and great product.",
      "Will definitely buy again!",
    ],
    neutral: [
      "Decent product, meets expectations.",
      "Good but could be better.",
      "Average quality, nothing special.",
      "Works as described.",
      "Okay for the price.",
    ],
    negative: [
      "Not as expected, disappointed.",
      "Quality could be much better.",
      "Took too long to arrive.",
      "Would not recommend.",
      "Did not meet my expectations.",
    ],
  };

  for (let i = 0; i < count; i++) {
    const product = randomElement(products);
    const customer = randomElement(customers);
    const rating = randomInt(1, 5);
    let comment;

    if (rating >= 4) {
      comment = randomElement(reviewPhrases.positive);
    } else if (rating >= 3) {
      comment = randomElement(reviewPhrases.neutral);
    } else {
      comment = randomElement(reviewPhrases.negative);
    }

    reviews.push({
      _id: new ObjectId(),
      productId: product._id,
      productName: product.name,
      customerId: customer._id,
      customerName: customer.name,
      rating,
      comment,
      createdAt: randomDate(new Date("2023-06-01"), new Date("2024-06-01")),
      helpful: randomInt(0, 50),
      verified: Math.random() > 0.3,
    });
  }

  return reviews;
}

async function seedDatabase() {
  console.log("Connecting to demo database...");
  const client = new MongoClient(DEMO_CONNECTION_STRING);

  try {
    await client.connect();
    const db = client.db(DEMO_DATABASE_NAME);

    console.log(`Connected to ${DEMO_DATABASE_NAME}`);

    // Drop existing collections
    console.log("Dropping existing collections...");
    const collections = await db.listCollections().toArray();
    for (const collection of collections) {
      await db.dropCollection(collection.name);
    }

    // Generate data
    console.log("Generating sample data...");
    const products = generateProducts(500);
    const customers = generateCustomers(200);
    const orders = generateOrders(products, customers, 1000);
    const reviews = generateReviews(products, customers, 800);

    // Insert data
    console.log("Inserting products...");
    await db.collection("products").insertMany(products);

    console.log("Inserting customers...");
    await db.collection("customers").insertMany(customers);

    console.log("Inserting orders...");
    await db.collection("orders").insertMany(orders);

    console.log("Inserting reviews...");
    await db.collection("reviews").insertMany(reviews);

    // Create indexes for better query performance
    console.log("Creating indexes...");
    await db.collection("products").createIndex({ category: 1 });
    await db.collection("products").createIndex({ price: 1 });
    await db.collection("products").createIndex({ rating: -1 });
    await db.collection("products").createIndex({ createdAt: -1 });

    await db.collection("customers").createIndex({ email: 1 }, { unique: true });
    await db.collection("customers").createIndex({ country: 1 });
    await db.collection("customers").createIndex({ signupDate: -1 });

    await db.collection("orders").createIndex({ customerId: 1 });
    await db.collection("orders").createIndex({ status: 1 });
    await db.collection("orders").createIndex({ createdAt: -1 });
    await db.collection("orders").createIndex({ total: -1 });

    await db.collection("reviews").createIndex({ productId: 1 });
    await db.collection("reviews").createIndex({ customerId: 1 });
    await db.collection("reviews").createIndex({ rating: -1 });
    await db.collection("reviews").createIndex({ createdAt: -1 });

    // Print summary
    console.log("\n=== Demo Database Seeded Successfully ===");
    console.log(`Products: ${products.length}`);
    console.log(`Customers: ${customers.length}`);
    console.log(`Orders: ${orders.length}`);
    console.log(`Reviews: ${reviews.length}`);
    console.log("\nCollections created:");
    console.log("  - products: E-commerce product catalog");
    console.log("  - customers: Customer profiles with order stats");
    console.log("  - orders: Order history with line items");
    console.log("  - reviews: Product reviews and ratings");
    console.log("\nSample queries to try:");
    console.log('  db.products.find({ category: "Electronics" }).limit(5)');
    console.log("  db.orders.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }])");
    console.log("  db.customers.find().sort({ totalSpent: -1 }).limit(10)");
    console.log("  db.reviews.find({ rating: { $gte: 4 } }).limit(10)");
  } finally {
    await client.close();
    console.log("\nDatabase connection closed.");
  }
}

// Run the seed script
seedDatabase().catch(console.error);
