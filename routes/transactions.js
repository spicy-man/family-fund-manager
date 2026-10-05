const { createTransactionService } = require('../lib/transaction-service');
const { handleApiError } = require('../lib/api-errors');

function registerTransactionRoutes(app, deps, utils) {
  const service = createTransactionService(deps, utils);

  app.get('/api/state', (req, res, next) => {
    try {
      res.json({ success: true, data: deps.getState() });
    } catch (error) {
      handleApiError(error, req, res, next);
    }
  });

  app.post('/api/transaction', (req, res, next) => {
    try {
      const event = service.createTransaction(req.body);
      res.json({ success: true, message: '交易记录登记成功', data: event });
    } catch (error) {
      handleApiError(error, req, res, next);
    }
  });

  app.post('/api/valuation', (req, res, next) => {
    try {
      const event = service.createValuation(req.body);
      res.json({ success: true, message: '资产估值更新成功', data: event });
    } catch (error) {
      handleApiError(error, req, res, next);
    }
  });

  app.post('/api/transfer', (req, res, next) => {
    try {
      const event = service.createTransfer(req.body);
      res.json({ success: true, message: '内部份额转让登记成功', data: event });
    } catch (error) {
      handleApiError(error, req, res, next);
    }
  });

  app.delete('/api/event/:id', (req, res, next) => {
    try {
      const event = service.deleteEvent(req.params.id);
      res.json({ success: true, message: '记录已成功删除，系统账目已自动完成重新计算。', data: event });
    } catch (error) {
      handleApiError(error, req, res, next);
    }
  });

  app.put('/api/event/:id', (req, res, next) => {
    try {
      const event = service.updateEvent(req.params.id, req.body);
      res.json({ success: true, message: '账目记录修改成功，系统已自动重算', data: event });
    } catch (error) {
      handleApiError(error, req, res, next);
    }
  });
}

module.exports = { registerTransactionRoutes };
