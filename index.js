// index.js
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

// ================= MIDDLEWARES =================
app.use(cors());
app.use(express.json());

// ================= FIREBASE ADMIN =================
try {
  const serviceAccount = JSON.parse(fs.readFileSync(process.env.FB_SERVICE_KEY, 'utf8'));
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  console.log("Firebase Admin initialized ✅");
} catch (err) {
  console.error("Firebase Admin initialization failed:", err);
}

// ================= JWT VERIFY MIDDLEWARE =================
const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).send({ message: 'Unauthorized' });

  try {
    const idToken = token.split(' ')[1];
    const decodedUser = await admin.auth().verifyIdToken(idToken);
    req.decoded_email = decodedUser.email;
    req.decoded_uid = decodedUser.uid;
    next();
  } catch (err) {
    return res.status(401).send({ message: 'Unauthorized', error: err.message });
  }
};

// ================= MONGODB CONNECTION =================
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

    console.log("MongoDB connected ✅");

    // ================= AUTH: FIREBASE LOGIN + AUTO-CREATE =================
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

    // ================= ADMIN ROUTES =================
    // Get all users
    app.get('/admin/users', verifyFBToken, async (req, res) => {
      const requester = await users.findOne({ email: req.decoded_email });
      if (!requester || requester.role !== 'admin') return res.status(403).send({ message: 'Forbidden' });

      const allUsers = await users.find({}).toArray();
      res.send({ success: true, users: allUsers.map(u => ({ ...u, _id: u._id.toString() })) });
    });

    // Update user role
    app.patch('/admin/users/:id/role', verifyFBToken, async (req, res) => {
      const requester = await users.findOne({ email: req.decoded_email });
      if (!requester || requester.role !== 'admin') return res.status(403).send({ message: 'Forbidden' });

      const { role } = req.body;
      const result = await users.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { role } });
      res.send({ success: result.modifiedCount > 0 });
    });

    // Get all books (admin)
    app.get('/admin/books', verifyFBToken, async (req, res) => {
      const requester = await users.findOne({ email: req.decoded_email });
      if (!requester || requester.role !== 'admin') return res.status(403).send({ message: 'Forbidden' });

      const allBooks = await books.find({}).toArray();
      res.send({ success: true, books: allBooks.map(b => ({ ...b, _id: b._id.toString() })) });
    });

    // Update book status (publish/unpublish)
    app.patch('/admin/books/:id/status', verifyFBToken, async (req, res) => {
      const requester = await users.findOne({ email: req.decoded_email });
      if (!requester || requester.role !== 'admin') return res.status(403).send({ message: 'Forbidden' });

      const { status } = req.body;
      const result = await books.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status } });
      res.send({ success: result.modifiedCount > 0 });
    });

    // Delete book + its orders
    app.delete('/admin/books/:id', verifyFBToken, async (req, res) => {
      const requester = await users.findOne({ email: req.decoded_email });
      if (!requester || requester.role !== 'admin') return res.status(403).send({ message: 'Forbidden' });

      await orders.deleteMany({ bookId: req.params.id });
      const result = await books.deleteOne({ _id: new ObjectId(req.params.id) });
      res.send({ success: result.deletedCount > 0 });
    });

  } finally {
    // keep-alive
  }
}

run().catch(console.error);




// ================= LIBRARIAN ROUTES =================

// Get all books added by the logged-in librarian
app.get('/librarian/my-books', verifyFBToken, async (req, res) => {
  const requester = await users.findOne({ email: req.decoded_email });
  if (!requester || requester.role !== 'librarian') return res.status(403).send({ message: 'Forbidden' });

  const myBooks = await books.find({ librarianEmail: req.decoded_email }).toArray();
  res.send({ success: true, books: myBooks.map(b => ({ ...b, _id: b._id.toString() })) });
});

// Update book (edit)
app.patch('/librarian/books/:id', verifyFBToken, async (req, res) => {
  const requester = await users.findOne({ email: req.decoded_email });
  if (!requester || requester.role !== 'librarian') return res.status(403).send({ message: 'Forbidden' });

  const { name, author, price, description, status, image } = req.body;
  const result = await books.updateOne(
    { _id: new ObjectId(req.params.id), librarianEmail: req.decoded_email },
    { $set: { name, author, price, description, status, image } }
  );

  res.send({ success: result.modifiedCount > 0 });
});

// Get all orders for the books added by the librarian
app.get('/librarian/orders', verifyFBToken, async (req, res) => {
  const requester = await users.findOne({ email: req.decoded_email });
  if (!requester || requester.role !== 'librarian') return res.status(403).send({ message: 'Forbidden' });

  // Get all book IDs added by this librarian
  const myBooks = await books.find({ librarianEmail: req.decoded_email }).toArray();
  const myBookIds = myBooks.map(b => b._id.toString());

  const myOrders = await orders.find({ bookId: { $in: myBookIds } }).toArray();
  res.send({ success: true, orders: myOrders.map(o => ({ ...o, _id: o._id.toString() })) });
});

// Cancel an order (librarian)
app.patch('/librarian/orders/:id/cancel', verifyFBToken, async (req, res) => {
  const requester = await users.findOne({ email: req.decoded_email });
  if (!requester || requester.role !== 'librarian') return res.status(403).send({ message: 'Forbidden' });

  // Only allow cancelling orders for the librarian's books
  const order = await orders.findOne({ _id: new ObjectId(req.params.id) });
  if (!order) return res.status(404).send({ message: 'Order not found' });

  const book = await books.findOne({ _id: new ObjectId(order.bookId) });
  if (book.librarianEmail !== req.decoded_email) return res.status(403).send({ message: 'Forbidden' });

  const result = await orders.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status: 'cancelled' } });
  res.send({ success: result.modifiedCount > 0 });
});

// Update order status (pending → shipped → delivered)
app.patch('/librarian/orders/:id/status', verifyFBToken, async (req, res) => {
  const requester = await users.findOne({ email: req.decoded_email });
  if (!requester || requester.role !== 'librarian') return res.status(403).send({ message: 'Forbidden' });

  const { status } = req.body;
  const allowedStatuses = ['pending', 'shipped', 'delivered'];
  if (!allowedStatuses.includes(status)) return res.status(400).send({ message: 'Invalid status' });

  const order = await orders.findOne({ _id: new ObjectId(req.params.id) });
  if (!order) return res.status(404).send({ message: 'Order not found' });

  const book = await books.findOne({ _id: new ObjectId(order.bookId) });
  if (book.librarianEmail !== req.decoded_email) return res.status(403).send({ message: 'Forbidden' });

  const result = await orders.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status } });
  res.send({ success: result.modifiedCount > 0 });
});


// ================= ROOT =================
app.get('/', (req, res) => res.send('BookCourier server is running 🚀'));
app.listen(port, () => console.log(`Server running on port ${port}`));
