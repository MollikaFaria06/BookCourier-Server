// index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ObjectId, ServerApiVersion } from "mongodb";
import admin from "firebase-admin";

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

// ================= MIDDLEWARE =================
app.use(cors({ origin: "*" }));


app.use(express.json());

// ================= FIREBASE ADMIN =================
try {
  const serviceAccount = JSON.parse(Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString("utf8"));

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  console.log("Firebase Admin initialized");
} catch (err) {
  console.error("Firebase init failed", err);
}

// ================= JWT VERIFY =================
const verifyFBToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).send({ message: "Unauthorized" });

  try {
    const token = authHeader.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(token);
    req.decoded_email = decoded.email;
    req.decoded_uid = decoded.uid;
    next();
  } catch (err) {
    return res.status(401).send({ message: "Unauthorized", error: err.message });
  }
};

// ================= MONGODB =================
const client = new MongoClient(process.env.DB_URI, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});

async function run() {
  try {
    await client.connect();
    const db = client.db(process.env.DB_NAME);

    const users = db.collection("users");
    const books = db.collection("books");
    const orders = db.collection("orders");
    const wishlists = db.collection("wishlists");

    console.log("MongoDB connected");

    const adminEmails = process.env.ADMIN_EMAILS.split(",").map((e) => e.trim());
    const librarianEmails = process.env.LIBRARIAN_EMAILS.split(",").map((e) => e.trim());

    // ================= AUTH =================
    app.post("/auth/firebase-login", verifyFBToken, async (req, res) => {
      try {
        const { name, picture } = req.body.user || {};
        let user = await users.findOne({ email: req.decoded_email });

        if (!user) {
          let role = "user";
          if (adminEmails.includes(req.decoded_email)) role = "admin";
          else if (librarianEmails.includes(req.decoded_email)) role = "librarian";

          const newUser = {
            uid: req.decoded_uid,
            email: req.decoded_email,
            name: name || "Anonymous",
            profileImage: picture || "",
            role,
            createdAt: new Date(),
          };

          const result = await users.insertOne(newUser);
          user = { ...newUser, _id: result.insertedId.toString() };
        } else {
          user._id = user._id.toString();
        }

        res.send({ success: true, user });
      } catch (err) {
        res.status(500).send({ success: false, message: "Login failed" });
      }
    });

    // ================= BOOKS =================
    app.post("/books", verifyFBToken, async (req, res) => {
      const book = { ...req.body, createdAt: new Date(), librarianEmail: req.decoded_email };
      const result = await books.insertOne(book);
      res.send({ success: true, id: result.insertedId });
    });

    app.get("/books", async (req, res) => {
      const data = await books.find({ status: "published" }).toArray();
      res.send({ success: true, books: data.map((b) => ({ ...b, _id: b._id.toString() })) });
    });

    app.get("/books/latest", async (req, res) => {
      const data = await books.find({ status: "published" }).sort({ createdAt: -1 }).limit(6).toArray();
      res.send({ success: true, books: data.map((b) => ({ ...b, _id: b._id.toString() })) });
    });

    app.get("/books/:id", async (req, res) => {
      const book = await books.findOne({ _id: new ObjectId(req.params.id) });
      if (!book) return res.status(404).send({ success: false, message: "Not found" });
      book._id = book._id.toString();
      res.send({ success: true, book });
    });

    // ================= WISHLIST =================
    app.post("/wishlist", verifyFBToken, async (req, res) => {
      const { bookId } = req.body;
      const email = req.decoded_email;
      if (!bookId) return res.status(400).send({ success: false, message: "BookId required" });

      const exists = await wishlists.findOne({ email, bookId });
      if (exists) return res.status(400).send({ success: false, message: "Already in wishlist" });

      const item = { email, bookId, createdAt: new Date() };
      const result = await wishlists.insertOne(item);
      res.send({ success: true, id: result.insertedId });
    });

    app.get("/wishlist", verifyFBToken, async (req, res) => {
      const email = req.decoded_email;
      const data = await wishlists.find({ email }).toArray();

      const enriched = await Promise.all(
        data.map(async (w) => {
          const book = await books.findOne({ _id: new ObjectId(w.bookId) });
          return { ...w, _id: w._id.toString(), book: book ? { ...book, _id: book._id.toString() } : null };
        })
      );

      res.send({ success: true, list: enriched });
    });

    app.delete("/wishlist/:id", verifyFBToken, async (req, res) => {
      const email = req.decoded_email;
      const item = await wishlists.findOne({ _id: new ObjectId(req.params.id) });
      if (!item || item.email !== email) return res.status(403).send({ success: false });

      await wishlists.deleteOne({ _id: new ObjectId(req.params.id) });
      res.send({ success: true });
    });

    // ================= ORDERS =================
    app.post("/orders", verifyFBToken, async (req, res) => {
      const order = { ...req.body, email: req.decoded_email, status: "pending", paymentStatus: "unpaid", createdAt: new Date() };
      const result = await orders.insertOne(order);
      res.send({ success: true, id: result.insertedId });
    });

    app.get("/users/my-orders", verifyFBToken, async (req, res) => {
      const data = await orders.find({ email: req.decoded_email }).toArray();
      res.send({ success: true, orders: data.map((o) => ({ ...o, _id: o._id.toString() })) });
    });

    app.put("/users/cancel/:id", verifyFBToken, async (req, res) => {
      const order = await orders.findOne({ _id: new ObjectId(req.params.id) });
      if (!order || order.email !== req.decoded_email) return res.status(403).send({ success: false });

      const result = await orders.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status: "cancelled" } });
      res.send({ success: result.modifiedCount > 0 });
    });

    app.put("/users/pay/:id", verifyFBToken, async (req, res) => {
      const order = await orders.findOne({ _id: new ObjectId(req.params.id) });
      if (!order || order.email !== req.decoded_email) return res.status(403).send({ success: false });

      const result = await orders.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { paymentStatus: "paid" } });
      res.send({ success: result.modifiedCount > 0 });
    });

    // ================= INVOICES =================
    app.get("/users/invoices", verifyFBToken, async (req, res) => {
      const userOrders = await orders.find({ email: req.decoded_email, paymentStatus: "paid" }).toArray();
      const invoices = await Promise.all(
        userOrders.map(async (o) => {
          const book = await books.findOne({ _id: new ObjectId(o.bookId) });
          return {
            _id: o._id.toString(),
            paymentId: o._id.toString().slice(-8).toUpperCase(),
            bookTitle: book?.title || o.bookTitle || "Unknown",
            amount: o.price || 0,
            date: o.createdAt,
          };
        })
      );
      res.send({ success: true, invoices });
    });

    // ================= LIBRARIAN =================
    app.get("/librarian/orders", verifyFBToken, async (req, res) => {
      const user = await users.findOne({ email: req.decoded_email });
      if (!user || user.role !== "librarian") return res.status(403).send({ message: "Forbidden" });

      const myBooks = await books.find({ librarianEmail: req.decoded_email }).toArray();
      const bookIds = myBooks.map((b) => b._id.toString());

      const data = await orders.find({ bookId: { $in: bookIds } }).toArray();
      const enriched = await Promise.all(
        data.map(async (o) => {
          const book = await books.findOne({ _id: new ObjectId(o.bookId) });
          const orderUser = await users.findOne({ email: o.email });
          return { ...o, _id: o._id.toString(), bookName: book?.title || "Unknown", userName: orderUser?.name || o.email };
        })
      );

      res.send({ success: true, orders: enriched });
    });

    app.patch("/librarian/orders/:id/status", verifyFBToken, async (req, res) => {
      const user = await users.findOne({ email: req.decoded_email });
      if (!user || user.role !== "librarian") return res.status(403).send({ message: "Forbidden" });

      const { status } = req.body;
      const validStatus = ["pending", "shipped", "delivered"];
      if (!validStatus.includes(status)) return res.status(400).send({ success: false, message: "Invalid status" });

      const order = await orders.findOne({ _id: new ObjectId(req.params.id) });
      if (!order) return res.status(404).send({ success: false, message: "Order not found" });

      const book = await books.findOne({ _id: new ObjectId(order.bookId) });
      if (book.librarianEmail !== req.decoded_email) return res.status(403).send({ message: "Forbidden" });

      const result = await orders.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status } });
      res.send({ success: result.modifiedCount > 0 });
    });

    // ================= ADMIN =================
    app.get("/admin/users", verifyFBToken, async (req, res) => {
      const adminUser = await users.findOne({ email: req.decoded_email });
      if (!adminUser || adminUser.role !== "admin") return res.status(403).send({ message: "Forbidden" });

      const data = await users.find({}).toArray();
      res.send({ success: true, users: data.map((u) => ({ ...u, _id: u._id.toString() })) });
    });

    app.patch("/admin/users/:id/role", verifyFBToken, async (req, res) => {
      const adminUser = await users.findOne({ email: req.decoded_email });
      if (!adminUser || adminUser.role !== "admin") return res.status(403).send({ message: "Forbidden" });

      const result = await users.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { role: req.body.role } });
      res.send({ success: result.modifiedCount > 0 });
    });

    app.get("/admin/books", verifyFBToken, async (req, res) => {
      const adminUser = await users.findOne({ email: req.decoded_email });
      if (!adminUser || adminUser.role !== "admin") return res.status(403).send({ message: "Forbidden" });

      const data = await books.find({}).toArray();
      res.send({ success: true, books: data.map((b) => ({ ...b, _id: b._id.toString() })) });
    });

    app.patch("/admin/books/:id/status", verifyFBToken, async (req, res) => {
      const adminUser = await users.findOne({ email: req.decoded_email });
      if (!adminUser || adminUser.role !== "admin") return res.status(403).send({ message: "Forbidden" });

      const { status } = req.body;
      const result = await books.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status } });
      res.send({ success: result.modifiedCount > 0 });
    });

    app.delete("/admin/books/:id", verifyFBToken, async (req, res) => {
      const adminUser = await users.findOne({ email: req.decoded_email });
      if (!adminUser || adminUser.role !== "admin") return res.status(403).send({ message: "Forbidden" });

      const bookId = req.params.id;
      await orders.deleteMany({ bookId });
      const result = await books.deleteOne({ _id: new ObjectId(bookId) });
      res.send({ success: result.deletedCount > 0 });
    });

    // ================= LIBRARIAN BOOKS =================
    app.get("/librarian/my-books", verifyFBToken, async (req, res) => {
      const user = await users.findOne({ email: req.decoded_email });
      if (!user || user.role !== "librarian") return res.status(403).send({ message: "Forbidden" });

      const data = await books.find({ librarianEmail: req.decoded_email }).toArray();
      res.send({ success: true, books: data.map((b) => ({ ...b, _id: b._id.toString() })) });
    });

    app.patch("/librarian/books/:id", verifyFBToken, async (req, res) => {
      const user = await users.findOne({ email: req.decoded_email });
      if (!user || user.role !== "librarian") return res.status(403).send({ message: "Forbidden" });

      const { status, title, author, price, description } = req.body;
      const result = await books.updateOne(
        { _id: new ObjectId(req.params.id), librarianEmail: req.decoded_email },
        { $set: { status, title, author, price, description } }
      );

      res.send({ success: result.modifiedCount > 0 });
    });

  } finally {
    // keep MongoDB connection open
  }
}

run().catch(console.error);

// ================= ROOT =================
app.get("/", (req, res) => {
  res.send("BookCourier server is running 🚀");
});

export default app;

