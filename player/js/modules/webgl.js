import lottie from './webgl_light';
import {
  setExpressionsPlugin,
  setExpressionInterfaces,
} from '../utils/common';
import Expressions from '../utils/expressions/Expressions';
import interfacesProvider from '../utils/expressions/InterfacesProvider';
import expressionPropertyDecorator from '../utils/expressions/ExpressionPropertyDecorator';
import expressionTextPropertyDecorator from '../utils/expressions/ExpressionTextPropertyDecorator';
import WGLGaussianBlurEffect from '../elements/webglElements/effects/WGLGaussianBlurEffect';
import { registerEffect as wglRegisterEffect } from '../elements/webglElements/WGLEffects';

// Registering expression plugin
setExpressionsPlugin(Expressions);
setExpressionInterfaces(interfacesProvider);
expressionPropertyDecorator();
expressionTextPropertyDecorator();

// Registering effects
wglRegisterEffect(29, WGLGaussianBlurEffect);

export default lottie;
