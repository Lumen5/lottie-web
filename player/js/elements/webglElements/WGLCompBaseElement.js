import BaseRenderer from '../../renderers/BaseRenderer';
import {
  extendPrototype,
} from '../../utils/functionExtensions';

function WGLCompBaseElement() {
}
extendPrototype([BaseRenderer], WGLCompBaseElement);

export default WGLCompBaseElement;
