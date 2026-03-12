require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/user.model.js');

mongoose.connect(process.env.MONGODB_URI).then(async () => {
  const users = await User.find({ name: /Super Admin/i });
  console.log(users.map(u => ({ id: u._id, name: u.name, email: u.email })));
  process.exit();
}).catch(console.error);
