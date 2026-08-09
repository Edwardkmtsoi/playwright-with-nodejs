import { Router } from 'express';
import { postRepcoProduct } from '../controllers/repco.controller';

const router = Router();

router.post('/product', postRepcoProduct);

export default router;
