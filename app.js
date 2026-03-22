const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

// ====================== 核心配置 ======================
app.use(cors());
app.use(express.json({ limit: '50mb' })); // 支持大体积Base64数据
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ====================== MongoDB 模型定义 ======================
const orderSchema = new mongoose.Schema({
  orderId: { type: String, unique: true, required: true },
  userName: { type: String, required: true },
  userPhone: { type: String, required: true },
  total: { type: Number, required: true },
  carList: [{
    name: String,
    price: String,
    school: String,
    from: String,
    to: String
  }],
  payType: { type: String, required: true },
  createTime: { type: String, required: true }, // 最后提交时间
  payScreenshots: [{ type: String }], // 存储Base64格式截图
  paymentRecords: [{
    payType: String,
    amount: Number,
    time: String
  }],
  isManuallyModified: { type: Boolean, default: false }, // 手动修改标记
  isMultiSubmit: { type: Boolean, default: false } // 多次提交标记
});

const Order = mongoose.model('Order', orderSchema);

// ====================== 数据库连接 ======================
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB 连接成功'))
  .catch(err => console.error('MongoDB 连接失败:', err));

// ====================== 工具函数 ======================
// 生成唯一订单号
function generateOrderId() {
  const date = new Date();
  const dateStr = date.getFullYear().toString() + 
                  String(date.getMonth() + 1).padStart(2, '0') + 
                  String(date.getDate()).padStart(2, '0');
  const randomStr = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `SQY${dateStr}${randomStr}`;
}

// 班次合并工具函数（核心功能，保留不变）
function mergeCarLists(oldList, newList) {
  const carMap = new Map();
  oldList.forEach(car => {
    if (car.name) {
      carMap.set(car.name, car);
    }
  });

  newList.forEach(car => {
    if (car.name) {
      carMap.set(car.name, car);
    }
  });

  const FIXED_CAR_ORDER = [
    '4月11日早送','4月11日晚接','4月12日早送','4月12日晚接',
    '4月11日中午考点更换','4月12日中午考点更换'
  ];
  
  return FIXED_CAR_ORDER
    .filter(name => carMap.has(name))
    .map(name => carMap.get(name));
}

// ====================== 核心接口（全部移除限流中间件） ======================
/**
 * 1. 管理员获取所有订单
 */
app.post('/api/getAllOrders', async (req, res) => {
  try {
    const { pwd } = req.body;
    if (pwd !== process.env.ADMIN_PWD) {
      return res.json({ code: -1, msg: '密码错误' });
    }
    const orders = await Order.find().sort({ createTime: -1 });
    res.json({ code: 0, data: orders });
  } catch (err) {
    console.error('获取订单失败:', err);
    res.json({ code: -1, msg: '获取订单失败' });
  }
});

/**
 * 2. 用户提交订单
 */
app.post('/api/submitOrder', async (req, res) => {
  try {
    const { userName, userPhone, total, carList, payType, createTime } = req.body;
    
    // 验证必填参数
    if (!userName || !userPhone || !total || !carList || !payType || !createTime) {
      return res.json({ code: -1, msg: '参数不全' });
    }

    // 按「姓名+电话」查找用户已有订单
    const existingOrder = await Order.findOne({
      userName,
      userPhone
    });

    if (existingOrder) {
      const mergedCarList = mergeCarLists(existingOrder.carList || [], carList || []);

      existingOrder.total = total;
      existingOrder.carList = mergedCarList;
      existingOrder.payType = payType;
      existingOrder.createTime = createTime;
      existingOrder.isMultiSubmit = true;
      existingOrder.paymentRecords.push({ payType, amount: total, time: createTime });
      await existingOrder.save();
      return res.json({ code: 0, msg: '提交成功（合并到原有订单）', orderId: existingOrder.orderId });
    } else {
      // 无订单：创建新订单
      const orderId = generateOrderId();
      const newOrder = new Order({
        orderId,
        userName,
        userPhone,
        total,
        carList,
        payType,
        createTime,
        isMultiSubmit: false,
        payScreenshots: [],
        paymentRecords: [{ payType, amount: total, time: createTime }]
      });
      await newOrder.save();
      return res.json({ code: 0, msg: '提交成功', orderId });
    }
  } catch (err) {
    console.error('提交订单失败:', err);
    res.json({ code: -1, msg: '提交失败，请重试' });
  }
});

/**
 * 3. 上传支付截图
 */
app.post('/api/uploadScreenshot', async (req, res) => {
  try {
    const { orderId, screenshots } = req.body;
    
    if (!orderId || !screenshots || !Array.isArray(screenshots)) {
      return res.json({ code: -1, msg: '参数错误' });
    }

    const order = await Order.findOne({ orderId });
    if (!order) {
      return res.json({ code: -1, msg: '订单不存在' });
    }

    // 追加Base64截图（去重）
    const uniqueScreenshots = [...new Set([...order.payScreenshots, ...screenshots])];
    order.payScreenshots = uniqueScreenshots;
    await order.save();

    res.json({ code: 0, msg: '截图上传成功' });
  } catch (err) {
    console.error('上传截图失败:', err);
    res.json({ code: -1, msg: '截图上传失败' });
  }
});

/**
 * 4. 管理员刷新订单金额
 */
app.post('/api/recalculateAmount', async (req, res) => {
  try {
    const { pwd, orderId } = req.body;
    if (pwd !== process.env.ADMIN_PWD) {
      return res.json({ code: -1, msg: '密码错误' });
    }

    const order = await Order.findOne({ orderId });
    if (!order) {
      return res.json({ code: -1, msg: '订单不存在' });
    }

    // 重新计算金额
    let newTotal = 0;
    order.carList.forEach(item => {
      newTotal += Number(item.price);
    });
    order.total = newTotal;
    order.isManuallyModified = true;
    await order.save();

    res.json({ code: 0, msg: `金额刷新成功，新金额：${newTotal}元` });
  } catch (err) {
    console.error('刷新金额失败:', err);
    res.json({ code: -1, msg: '刷新金额失败' });
  }
});

/**
 * 5. 管理员删除订单
 */
app.post('/api/deleteOrder', async (req, res) => {
  try {
    const { pwd, id } = req.body;
    if (pwd !== process.env.ADMIN_PWD) {
      return res.json({ code: -1, msg: '密码错误' });
    }

    const result = await Order.findByIdAndDelete(id);
    if (!result) {
      return res.json({ code: -1, msg: '订单不存在' });
    }

    res.json({ code: 0, msg: '订单删除成功' });
  } catch (err) {
    console.error('删除订单失败:', err);
    res.json({ code: -1, msg: '删除失败' });
  }
});

/**
 * 6. 用户查询订单
 */
app.get('/api/queryOrder', async (req, res) => {
  try {
    const { userName } = req.query;
    if (!userName) {
      return res.json({ code: -1, msg: '请输入姓名' });
    }

    const orders = await Order.find({ userName: new RegExp(userName) }).sort({ createTime: -1 });
    res.json({ code: 0, data: orders });
  } catch (err) {
    console.error('查询订单失败:', err);
    res.json({ code: -1, msg: '查询失败' });
  }
});

// ====================== 启动服务 ======================
app.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
});
