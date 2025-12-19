// server.js
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { MongoClient, ObjectId, ServerApiVersion } from 'mongodb';
import admin from 'firebase-admin';
import Stripe from 'stripe';
import fs from 'fs';

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;
const stripe = new Stripe(process.env.STRIPE_SECRET);

// Middlewares
app.use(cors());
app.use(express.json());

// Firebase Admin Init
try {
  const serviceAccount = JSON.parse(fs.readFileSync(process.env.FB_SERVICE_KEY, 'utf8'));
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  console.log(" Firebase Admin initialized");
} catch (err) {
  console.error(" Firebase Admin initialization failed:", err);
}

// JWT verify middleware
const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).send({ message: 'unauthorized' });

  try {
    const idToken = token.split(' ')[1];
    const decodedUser = await admin.auth().verifyIdToken(idToken);
    req.decoded_email = decodedUser.email;
    req.decoded_uid = decodedUser.uid;
    next();
  } catch (err) {
    return res.status(401).send({ message: 'unauthorized', error: err.message });
  }
};

// MongoDB Init
const client = new MongoClient(process.env.DB_URI, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
});

async function run() {
  try {
    await client.connect();
    const db = client.db(process.env.DB_NAME);

    const users = db.collection('users');
    const books = db.collection('books');
    const orders = db.collection('orders');

    console.log(" MongoDB connected");

    // ================= AUTH: Firebase Login + Auto-create =================
    app.post('/auth/firebase-login', verifyFBToken, async (req, res) => {
      try {
        const { name, picture } = req.body.user || {};
        let user = await users.findOne({ email: req.decoded_email });

        if (!user) {
          // Role assignment
          let role = 'user';
          const adminEmails = ['admin@gmail.com'];
          const librarianEmails = ['librarian@gmail.com'];
          if (adminEmails.includes(req.decoded_email)) role = 'admin';
          else if (librarianEmails.includes(req.decoded_email)) role = 'librarian';

          const newUser = {
            uid: req.decoded_uid,
            email: req.decoded_email,
            name: name || 'Anonymous',
            profileImage: picture || '',
            role,
            createdAt: new Date()
          };

          const result = await users.insertOne(newUser);
          user = { ...newUser, _id: result.insertedId.toString() };
        } else {
          user._id = user._id.toString();
        }

        res.send({ success: true, user });
      } catch (err) {
        console.error(err);
        res.status(500).send({ success: false, message: 'Login failed' });
      }
    });

    // ================= BOOKS =================
    app.post('/books', verifyFBToken, async (req, res) => {
      const book = req.body;
      book.createdAt = new Date();
      book.librarianEmail = req.decoded_email;
      const result = await books.insertOne(book);
      res.send(result);
    });

    app.get('/books', async (req, res) => {
      try {
        const booksArray = await books.find({ status: 'published' }).toArray();
        res.send({ success: true, books: booksArray.map(b => ({ ...b, _id: b._id.toString() })) });
      } catch (err) {
        res.status(500).send({ success: false, message: 'Failed to fetch books' });
      }
    });

    app.get('/books/latest', async (req, res) => {
      try {
        const latestBooks = await books.find({ status: 'published' })
          .sort({ createdAt: -1 })
          .limit(6)
          .toArray();
        res.send({ success: true, books: latestBooks.map(b => ({ ...b, _id: b._id.toString() })) });
      } catch (err) {
        res.status(500).send({ success: false, message: 'Failed to fetch latest books' });
      }
    });

    app.get('/books/:id', async (req, res) => {
      try {
        const book = await books.findOne({ _id: new ObjectId(req.params.id) });
        if (!book) return res.status(404).send({ success: false, message: 'Book not found' });
        book._id = book._id.toString();
        res.send({ success: true, book });
      } catch (err) {
        res.status(500).send({ success: false, message: 'Book not found' });
      }
    });

    // ================= ORDERS =================
    app.post('/orders', verifyFBToken, async (req, res) => {
      const order = req.body;
      order.email = req.decoded_email;
      order.status = 'pending';
      order.paymentStatus = 'unpaid';
      order.createdAt = new Date();
      const result = await orders.insertOne(order);
      res.send(result);
    });

  } finally {
    // keep alive
  }
}

run().catch(console.error);

// Root
app.get('/', (req, res) => res.send('BookCourier server is running 🚀'));
app.listen(port, () => console.log(`Server running on port ${port}`));
